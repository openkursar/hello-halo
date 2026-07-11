/**
 * Transport-repoint seam (eng-core) — the production mechanism by which a survivor
 * redirects its outbound federation leg onto a NEWLY-ELECTED authority after the old
 * host is lost, WITHOUT rebuilding the coordinator/link.
 *
 * Two entrypoints on the real FederationManager:
 *   - repointLink(officeId, newSendTarget) — swap the office link's outbound sender
 *     in place; the inbound handler + link identity are unchanged. Returns false when
 *     no office with that id is hosted or joined here.
 *   - redialToAuthority(officeId, authorityNodeId) — resolve a sender via the
 *     injected PeerDialer and repoint to it. Returns false when the office is absent
 *     OR the dialer cannot route (the default no-op dialer always returns false).
 *
 * The coordinator-level rig (_rig/*.rig.test.ts) already drives election→handover→
 * replication over an in-memory transport. THIS suite proves the link-redirect that
 * production actually performs on host loss: after the redirect, frames the office
 * emits on its (unchanged) link land at the NEW authority's inbound and STOP reaching
 * the dead host. It is the seam the rig's survivor-continuation note deferred to.
 *
 * Fully synchronous, timer-free: each inbound is a recording sink in a routing table;
 * "killing" the host removes its sink so a pre-redirect frame is black-holed, and the
 * redirect re-targets a live survivor. The link under observation is the REAL
 * LanMeshLink the manager owns (read back via getOffice().link).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../src/main/platform/store/types'
import { FederationStore } from '../../../../../src/main/apps/federation/store'
import {
  MIGRATION_NAMESPACE as FED_NS,
  migrations as fedMigrations,
} from '../../../../../src/main/apps/federation/migrations'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import {
  MIGRATION_NAMESPACE as TEAM_NS,
  migrations as teamMigrations,
} from '../../../../../src/main/apps/team/migrations'
import {
  createFederationManager,
  type PeerDialer,
} from '../../../../../src/main/apps/runtime/federation/manager'
import type { FederationMessage } from '../../../../../src/main/apps/runtime/federation'

const OFFICE = 'office-seam'
const NODE_B = 'node-b' // survivor that hosts the office under test
const NODE_NEW_AUTH = 'node-new-authority' // the elected authority after host loss
const TOKEN = 'valid-token'

function makeStores(db: ReturnType<DatabaseManager['getAppDatabase']>) {
  return { federationStore: new FederationStore(db), teamStore: new TeamStore(db) }
}

/** A heartbeat is the simplest well-formed frame to route + observe end-to-end. */
function heartbeat(from: string): FederationMessage {
  return { kind: 'heartbeat', officeId: OFFICE, fromNode: from, ts: 1 } as FederationMessage
}

describe('transport-repoint seam — survivor redirects its link to the new authority', () => {
  let dbManager: DatabaseManager
  let federationStore: FederationStore
  let teamStore: TeamStore

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, FED_NS, fedMigrations)
    dbManager.runMigrations(db, TEAM_NS, teamMigrations)
    const stores = makeStores(db)
    federationStore = stores.federationStore
    teamStore = stores.teamStore
  })

  afterEach(() => {
    dbManager.closeAll()
  })

  /**
   * Build node B's real FederationManager hosting OFFICE. The host-send leg pushes
   * into a routing table keyed by clientId==nodeId; deleting a key models a dead
   * peer (its frames black-hole). A PeerDialer resolves a sender into the same table
   * so redialToAuthority can repoint to a live node. Returns the manager + observers.
   */
  function buildHost() {
    // inbound sinks per peer node; removing one models that node dying.
    const sinks = new Map<string, FederationMessage[]>()
    sinks.set(NODE_NEW_AUTH, [])

    const manager = createFederationManager({
      // The host's outbound resolves nodeId→clientId internally then calls hostSend.
      // We use clientId==nodeId so a frame for `to` lands in that node's sink.
      hostSend: (clientId, frame) => {
        const inbox = sinks.get(clientId)
        if (!inbox) return false // dead/unknown peer → send fails (frame dropped)
        inbox.push(frame)
        return true
      },
      hostListOfficeClients: () => [...sinks.keys()],
      federationStore,
      teamStore,
      verifyCredential: (t) => (t === TOKEN ? { officeId: OFFICE } : null),
      getLocalNodeId: () => NODE_B,
      // Production-shape dialer: resolve a sender that lands in the target's sink,
      // or null when the node is unreachable (fail-closed, like the default no-op).
      peerDialer: ((_officeId, authorityNodeId) => {
        const inbox = sinks.get(authorityNodeId)
        if (!inbox) return null
        return (_to, frame) => inbox.push(frame)
      }) as PeerDialer,
    })

    manager.hostOffice(OFFICE)
    const link = manager.getOffice(OFFICE)!.link
    return { manager, link, sinks }
  }

  it('repointLink swaps the office leg onto the new authority; the dead host receives nothing', () => {
    const { manager, link, sinks } = buildHost()

    const newAuthInbox = sinks.get(NODE_NEW_AUTH)!
    const ok = manager.repointLink(OFFICE, (_to, frame) => newAuthInbox.push(frame))
    expect(ok).toBe(true)

    // A frame the office now emits on its UNCHANGED link goes to the new authority.
    link.broadcast(heartbeat(NODE_B))
    expect(newAuthInbox).toHaveLength(1)
    expect(newAuthInbox[0]).toMatchObject({ kind: 'heartbeat', fromNode: NODE_B })
  })

  it('repointLink returns false for an office that is neither hosted nor joined', () => {
    const { manager } = buildHost()
    expect(manager.repointLink('office-does-not-exist', () => {})).toBe(false)
  })

  it('redialToAuthority resolves via the PeerDialer and repoints to the live authority', () => {
    const { manager, link, sinks } = buildHost()

    const ok = manager.redialToAuthority(OFFICE, NODE_NEW_AUTH)
    expect(ok).toBe(true)

    link.broadcast(heartbeat(NODE_B))
    expect(sinks.get(NODE_NEW_AUTH)!).toHaveLength(1)
  })

  it('redialToAuthority returns false (fail-closed) when the dialer cannot route to the node', () => {
    const { manager } = buildHost()
    // No sink for an unknown node → dialer returns null → redial fails closed and
    // does NOT repoint the link.
    expect(manager.redialToAuthority(OFFICE, 'node-unreachable')).toBe(false)
  })

  it('a repoint on a closed link is ignored (no throw, no delivery)', () => {
    const { manager, link, sinks } = buildHost()
    const newAuthInbox = sinks.get(NODE_NEW_AUTH)!

    // Closing the link (peer left) then repointing must be a safe no-op: the swap is
    // ignored and a subsequent broadcast delivers nothing.
    link.close()
    expect(manager.repointLink(OFFICE, (_to, frame) => newAuthInbox.push(frame))).toBe(true)
    link.broadcast(heartbeat(NODE_B))
    expect(newAuthInbox).toHaveLength(0)
  })
})
