/**
 * apps/federation -- SQLite Store
 *
 * Low-level CRUD for office_nodes (presence/join-order) and office_credentials
 * (issuance/revocation ledger). No business rules enforced here — that's the
 * future federation service/authority layer's job. Every write targets a
 * single primary key, so no in-process locking is needed.
 */

import type Database from 'better-sqlite3'
import type {
  OfficeNode,
  OfficeCredentialRecord,
  OfficeScope,
  OfficeNodeRow,
  OfficeCredentialRow,
  JoinedOfficeConnection,
  JoinedOfficeConnectionRow,
  FederationStore as IFederationStore,
} from './types'
import { encodeForStorage, decodeFromStorage } from '../../foundation/crypto-envelope'

// ── Row <-> Domain Mapping ──

function rowToNode(row: OfficeNodeRow): OfficeNode {
  return {
    nodeId: row.node_id,
    officeId: row.office_id,
    identity: row.identity,
    displayName: row.display_name,
    joinedAt: row.joined_at,
    lastSeen: row.last_seen,
    status: row.status as OfficeNode['status'],
    advertisedUrl: row.advertised_url,
  }
}

function rowToCredential(row: OfficeCredentialRow): OfficeCredentialRecord {
  let scope: OfficeScope
  try {
    scope = JSON.parse(row.scope_json) as OfficeScope
  } catch {
    scope = {
      visibility: 'full',
      contactable: 'all',
      discoverable: true,
      canReinvite: true,
    }
  }
  return {
    jti: row.jti,
    officeId: row.office_id,
    identity: row.identity,
    scope,
    exp: row.exp,
    issuedAt: row.issued_at,
    revoked: row.revoked === 1,
  }
}

function rowToJoinedConnection(row: JoinedOfficeConnectionRow): JoinedOfficeConnection {
  let bringAppIds: string[]
  try {
    const parsed = JSON.parse(row.bring_app_ids) as unknown
    bringAppIds = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    bringAppIds = []
  }
  return {
    officeId: row.office_id,
    serverUrl: row.server_url,
    inviteToken: decodeFromStorage(row.invite_token),
    bringAppIds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ── FederationStore ──

export class FederationStore implements IFederationStore {
  // office_nodes
  private readonly stmtUpsertNode: Database.Statement
  private readonly stmtGetNode: Database.Statement
  private readonly stmtListNodesByOffice: Database.Statement
  private readonly stmtSetNodeStatus: Database.Statement
  private readonly stmtTouchNode: Database.Statement
  private readonly stmtRemoveNode: Database.Statement
  // office_credentials
  private readonly stmtInsertCredential: Database.Statement
  private readonly stmtGetCredential: Database.Statement
  private readonly stmtRevokeCredential: Database.Statement
  private readonly stmtIsRevoked: Database.Statement
  private readonly stmtListCredentialsByOffice: Database.Statement
  // joined_office_connections
  private readonly stmtUpsertJoinedConn: Database.Statement
  private readonly stmtListJoinedConns: Database.Statement
  private readonly stmtRemoveJoinedConn: Database.Statement

  constructor(private readonly db: Database.Database) {
    // ── office_nodes ──────────────────────────────
    // Upsert keyed by (office_id, node_id) — one row per office a node is in;
    // caller must pass the original joined_at on rejoin to preserve join-order
    // semantics (this upsert does not protect it).
    this.stmtUpsertNode = db.prepare(`
      INSERT INTO office_nodes (
        office_id, node_id, identity, display_name, joined_at, last_seen, status, advertised_url
      ) VALUES (
        @office_id, @node_id, @identity, @display_name, @joined_at, @last_seen, @status, @advertised_url
      )
      ON CONFLICT(office_id, node_id) DO UPDATE SET
        identity = excluded.identity,
        display_name = excluded.display_name,
        joined_at = excluded.joined_at,
        last_seen = excluded.last_seen,
        status = excluded.status,
        advertised_url = COALESCE(excluded.advertised_url, office_nodes.advertised_url)
    `)
    this.stmtGetNode = db.prepare(`
      SELECT * FROM office_nodes WHERE office_id = ? AND node_id = ?
    `)
    this.stmtListNodesByOffice = db.prepare(`
      SELECT * FROM office_nodes WHERE office_id = ? ORDER BY joined_at ASC
    `)
    this.stmtSetNodeStatus = db.prepare(`
      UPDATE office_nodes SET status = @status, last_seen = @last_seen
        WHERE office_id = @office_id AND node_id = @node_id
    `)
    this.stmtTouchNode = db.prepare(`
      UPDATE office_nodes SET last_seen = @last_seen
        WHERE office_id = @office_id AND node_id = @node_id
    `)
    this.stmtRemoveNode = db.prepare(`
      DELETE FROM office_nodes WHERE office_id = ? AND node_id = ?
    `)

    // ── office_credentials ────────────────────────
    this.stmtInsertCredential = db.prepare(`
      INSERT INTO office_credentials (
        jti, office_id, identity, scope_json, exp, issued_at, revoked
      ) VALUES (
        @jti, @office_id, @identity, @scope_json, @exp, @issued_at, @revoked
      )
    `)
    this.stmtGetCredential = db.prepare(`SELECT * FROM office_credentials WHERE jti = ?`)
    this.stmtRevokeCredential = db.prepare(`
      UPDATE office_credentials SET revoked = 1 WHERE jti = ?
    `)
    this.stmtIsRevoked = db.prepare(`SELECT revoked FROM office_credentials WHERE jti = ?`)
    this.stmtListCredentialsByOffice = db.prepare(`
      SELECT * FROM office_credentials WHERE office_id = ? ORDER BY issued_at ASC
    `)

    // ── joined_office_connections ─────────────────
    this.stmtUpsertJoinedConn = db.prepare(`
      INSERT INTO joined_office_connections (
        office_id, server_url, invite_token, bring_app_ids, created_at, updated_at
      ) VALUES (
        @office_id, @server_url, @invite_token, @bring_app_ids, @created_at, @updated_at
      )
      ON CONFLICT(office_id) DO UPDATE SET
        server_url = excluded.server_url,
        invite_token = excluded.invite_token,
        bring_app_ids = excluded.bring_app_ids,
        updated_at = excluded.updated_at
    `)
    this.stmtListJoinedConns = db.prepare(`
      SELECT * FROM joined_office_connections ORDER BY created_at ASC
    `)
    this.stmtRemoveJoinedConn = db.prepare(`
      DELETE FROM joined_office_connections WHERE office_id = ?
    `)
  }

  // ── office_nodes ────────────────────────────────

  upsertNode(node: OfficeNode): void {
    this.stmtUpsertNode.run({
      office_id: node.officeId,
      node_id: node.nodeId,
      identity: node.identity,
      display_name: node.displayName,
      joined_at: node.joinedAt,
      last_seen: node.lastSeen,
      status: node.status,
      // COALESCE in the upsert keeps a previously-learned URL when a caller
      // (e.g. a presence refresh) upserts without one.
      advertised_url: node.advertisedUrl ?? null,
    })
  }

  getNode(officeId: string, nodeId: string): OfficeNode | null {
    const row = this.stmtGetNode.get(officeId, nodeId) as OfficeNodeRow | undefined
    return row ? rowToNode(row) : null
  }

  /** Nodes in an office ordered by join time (ascending) — election by join order. */
  listNodesByOffice(officeId: string): OfficeNode[] {
    return (this.stmtListNodesByOffice.all(officeId) as OfficeNodeRow[]).map(rowToNode)
  }

  setNodeStatus(officeId: string, nodeId: string, status: OfficeNode['status'], lastSeen: number): void {
    this.stmtSetNodeStatus.run({ office_id: officeId, node_id: nodeId, status, last_seen: lastSeen })
  }

  /** Refresh presence without changing status (heartbeat). */
  touchNode(officeId: string, nodeId: string, lastSeen: number): void {
    this.stmtTouchNode.run({ office_id: officeId, node_id: nodeId, last_seen: lastSeen })
  }

  removeNode(officeId: string, nodeId: string): boolean {
    return this.stmtRemoveNode.run(officeId, nodeId).changes > 0
  }

  // ── office_credentials ──────────────────────────

  /**
   * @throws If PRIMARY KEY (jti) is violated.
   */
  insertCredential(rec: OfficeCredentialRecord): void {
    this.stmtInsertCredential.run({
      jti: rec.jti,
      office_id: rec.officeId,
      identity: rec.identity,
      scope_json: JSON.stringify(rec.scope),
      exp: rec.exp,
      issued_at: rec.issuedAt,
      revoked: rec.revoked ? 1 : 0,
    })
  }

  getCredential(jti: string): OfficeCredentialRecord | null {
    const row = this.stmtGetCredential.get(jti) as OfficeCredentialRow | undefined
    return row ? rowToCredential(row) : null
  }

  revokeCredential(jti: string): boolean {
    return this.stmtRevokeCredential.run(jti).changes > 0
  }

  /** True only when the credential exists and is revoked. Unknown jti → false. */
  isRevoked(jti: string): boolean {
    const row = this.stmtIsRevoked.get(jti) as { revoked: number } | undefined
    return row?.revoked === 1
  }

  listCredentialsByOffice(officeId: string): OfficeCredentialRecord[] {
    return (this.stmtListCredentialsByOffice.all(officeId) as OfficeCredentialRow[]).map(rowToCredential)
  }

  // ── joined_office_connections ───────────────────

  /** Token is envelope-encoded here; created_at is preserved on update by the upsert. */
  upsertJoinedOfficeConnection(conn: JoinedOfficeConnection): void {
    this.stmtUpsertJoinedConn.run({
      office_id: conn.officeId,
      server_url: conn.serverUrl,
      invite_token: encodeForStorage(conn.inviteToken),
      bring_app_ids: JSON.stringify(conn.bringAppIds),
      created_at: conn.createdAt,
      updated_at: conn.updatedAt,
    })
  }

  listJoinedOfficeConnections(): JoinedOfficeConnection[] {
    return (this.stmtListJoinedConns.all() as JoinedOfficeConnectionRow[]).map(rowToJoinedConnection)
  }

  removeJoinedOfficeConnection(officeId: string): boolean {
    return this.stmtRemoveJoinedConn.run(officeId).changes > 0
  }
}
