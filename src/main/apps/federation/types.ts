/**
 * apps/federation -- Type Definitions
 *
 * Types for the office federation persistence layer: presence/join-order
 * (office_nodes) and the credential issuance/revocation ledger
 * (office_credentials). This is zero-team-collaboration-semantics federation
 * infrastructure, kept out of the app_team namespace.
 *
 * Renderer-unaware: pure data shapes, no Node/Electron imports beyond types.
 */

// ── Office scope (permission overlay) ──

/** The permission overlay carried by an office credential. */
export interface OfficeScope {
  visibility: 'full' | 'assigned' | 'readonly'
  contactable: 'all' | 'lead-only'
  discoverable: boolean
  canReinvite: boolean
}

/** Default-open scope applied when none is specified. */
export const DEFAULT_OFFICE_SCOPE: OfficeScope = {
  visibility: 'full',
  contactable: 'all',
  discoverable: true,
  canReinvite: true,
}

// ── SQLite Row Types (flat DB representation) ──

export interface OfficeNodeRow {
  node_id: string
  office_id: string
  identity: string
  display_name: string | null
  joined_at: number
  last_seen: number
  status: string
  advertised_url: string | null
}

export interface OfficeCredentialRow {
  jti: string
  office_id: string
  identity: string
  scope_json: string
  exp: number | null
  issued_at: number
  revoked: number
}

/**
 * `invite_token` is the envelope-encoded form on disk; the store decodes it to
 * plaintext when mapping to the domain type.
 */
export interface JoinedOfficeConnectionRow {
  office_id: string
  server_url: string
  invite_token: string
  bring_app_ids: string
  created_at: number
  updated_at: number
}

// ── Domain entities ──

export interface OfficeNode {
  nodeId: string
  officeId: string
  /** The portable Identity.id this node authenticates as. */
  identity: string
  displayName: string | null
  joinedAt: number
  lastSeen: number
  /**
   * Reachability status. 'suspect' is a debounce buffer state; the DB column
   * is TEXT and stores it verbatim, so no migration is needed.
   */
  status: 'online' | 'suspect' | 'offline'
  /**
   * Base URL of the node's own HTTP/WS server (its remote-access lanUrl),
   * advertised at join so peers can dial it after a transport loss (e.g. a
   * survivor re-pointing at a newly-elected authority). Null when the node
   * runs no reachable server — it can dial out but cannot be dialed.
   */
  advertisedUrl: string | null
}

export interface OfficeCredentialRecord {
  jti: string
  officeId: string
  identity: string
  scope: OfficeScope
  /** Expiry epoch ms; null = no expiry. */
  exp: number | null
  issuedAt: number
  revoked: boolean
}

/**
 * A persisted "I am a member of this remote office" record, sufficient to
 * re-join it after a restart. `bringAppIds` is the set of local apps this node
 * currently keeps in the office — the record is removed once that set empties
 * on an explicit exit.
 */
export interface JoinedOfficeConnection {
  officeId: string
  serverUrl: string
  inviteToken: string
  bringAppIds: string[]
  createdAt: number
  updatedAt: number
}

// ── Replication log + authority/term state ──

export type ReplicationOpName =
  | 'post_task'
  | 'update_task'
  | 'post_finding'
  | 'roster_join'
  | 'roster_leave'

/** One persisted replication-log entry (app_federation.blackboard_replication_log). */
export interface ReplicationLogEntry {
  officeId: string
  /** per-office monotonic, assigned by the single writer. */
  seq: number
  /** Authority tenure this write belongs to. */
  term: number
  op: ReplicationOpName
  /** Structured write payload (JSON-serializable team-tool args / output). */
  payload: Record<string, unknown>
  /** Cross-restart globally-unique frame id (idempotency key). */
  fid: string
  /** Present when the op concerns a task (duplicate-task-id probe). */
  taskId: string | null
  createdAt: number
}

export interface ReplicationLogRow {
  office_id: string
  seq: number
  term: number
  op: string
  payload: string
  fid: string
  task_id: string | null
  created_at: number
}

/** Per-office authority/term + replication water marks (office_authority). */
export interface AuthorityState {
  officeId: string
  /** Current authority tenure; +1 on each successful election. */
  term: number
  /** The node this office currently believes is the authority (null until known). */
  authorityNodeId: string | null
  /** Replicated roster version — the last-known-roster quorum basis. */
  rosterEpoch: number
  /** Highest seq that reached replication quorum (handover baseline). */
  committedSeq: number
  /** Highest seq applied locally (optimistic; ≥ committedSeq). */
  appliedSeq: number
  updatedAt: number
}

export interface AuthorityStateRow {
  office_id: string
  term: number
  authority_node_id: string | null
  roster_epoch: number
  committed_seq: number
  applied_seq: number
  updated_at: number
}

/**
 * Partial patch for office_authority; omitted fields are preserved. A fresh row
 * defaults every field (term 0, seqs 0) before applying the patch.
 */
export type AuthorityStatePatch = Partial<Omit<AuthorityState, 'officeId' | 'updatedAt'>>

/**
 * Persistence contract for the replication log + authority/term state. Kept
 * separate from FederationStore so its node/credential ledger interface stays
 * focused; both are backed by the same app_federation database.
 */
export interface AuthorityStore {
  // ── blackboard_replication_log ──
  /** Append one entry (single-writer authority). Throws on (office,seq) or (office,fid) clash. */
  appendLogEntry(entry: ReplicationLogEntry): void
  /** Highest seq persisted for an office (0 if none) — for monotonic continuation. */
  getMaxSeq(officeId: string): number
  /** True if (officeId, fid) already exists in the log (cross-restart idempotency). */
  hasFid(officeId: string, fid: string): boolean
  /** Entries with seq in (afterSeq, afterSeq+limit] ordered ascending (catch-up). */
  listLogAfter(officeId: string, afterSeq: number, limit: number): ReplicationLogEntry[]
  /** The lowest seq still retained (for "gap exceeds retained → snapshot" decisions). */
  getMinSeq(officeId: string): number
  /** Drop entries with seq <= beforeSeq (retention trim). Returns rows removed. */
  pruneLogBefore(officeId: string, beforeSeq: number): number
  /** Count log entries carrying a given task id (duplicate-task-id probe). */
  countByTaskId(officeId: string, taskId: string): number

  // ── office_authority ──
  getAuthorityState(officeId: string): AuthorityState | null
  /** Upsert (create-then-patch) the office authority row. Returns the new state. */
  patchAuthorityState(officeId: string, patch: AuthorityStatePatch, at: number): AuthorityState
}

// ── FederationStore Interface ──

/**
 * Persistence contract for the office federation data layer.
 *
 * All methods are synchronous (better-sqlite3). The store performs no business
 * validation beyond SQLite constraints — issuance/revocation policy and
 * election rules live in the future federation service/authority layer.
 */
export interface FederationStore {
  // ── office_nodes ──────────────────────────────
  // Rows are keyed by (officeId, nodeId): a node keeps one row per office it is
  // in (it can host one office while joined to others).
  upsertNode(node: OfficeNode): void
  getNode(officeId: string, nodeId: string): OfficeNode | null
  listNodesByOffice(officeId: string): OfficeNode[]
  setNodeStatus(officeId: string, nodeId: string, status: OfficeNode['status'], lastSeen: number): void
  touchNode(officeId: string, nodeId: string, lastSeen: number): void
  removeNode(officeId: string, nodeId: string): boolean

  // ── office_credentials ────────────────────────
  insertCredential(rec: OfficeCredentialRecord): void
  getCredential(jti: string): OfficeCredentialRecord | null
  revokeCredential(jti: string): boolean
  isRevoked(jti: string): boolean
  listCredentialsByOffice(officeId: string): OfficeCredentialRecord[]

  // ── joined_office_connections ─────────────────
  /** Insert/replace the re-join record for an office (token encoded at rest). */
  upsertJoinedOfficeConnection(conn: JoinedOfficeConnection): void
  /** All offices this node intends to re-join on restart (tokens decoded). */
  listJoinedOfficeConnections(): JoinedOfficeConnection[]
  /** Drop the re-join record on an explicit exit. Returns true when a row went. */
  removeJoinedOfficeConnection(officeId: string): boolean
}
