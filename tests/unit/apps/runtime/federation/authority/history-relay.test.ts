/**
 * Host-relayed member history (joiner → joiner read through the host hop).
 *
 * Joiners only link to the host, so a joiner asking for a member owned by
 * ANOTHER joiner lands its `history-request` on the host. The host does not own
 * the member — instead of refusing, it forwards the request one hop to the true
 * owner and pipes the owner's `history-response` back to the requester. This is
 * what makes "everyone sees the same transcript" hold in a 3+ node office.
 *
 * Three real OfficeAuthority instances over a star-routed hub that mimics the
 * production transport: a joiner's send always lands on the HOST regardless of
 * the addressed node (LanMeshLink client semantics); only the host routes by
 * node id. Proven end-to-end:
 *   - relay served: V (joiner) pulls O's (peer joiner) member transcript;
 *   - relay preserves authorization: the OWNER's gate still runs (not-owned on a
 *     stale roster refuses instead of re-relaying — one hop max);
 *   - relay fail-fast: a suspect/offline owner rejects immediately with
 *     `history-owner-unreachable` (no relay-timeout wait);
 *   - relay timeout: an unresponsive owner surfaces `history-relay-failed`
 *     BEFORE the requester's own deadline.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { createDatabaseManager } from '../../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../../src/main/platform/store/types'
import { FederationStore } from '../../../../../../src/main/apps/federation/store'
import { AuthorityStore } from '../../../../../../src/main/apps/federation/authority-store'
import {
  MIGRATION_NAMESPACE as FED_NS,
  migrations as fedMigrations,
} from '../../../../../../src/main/apps/federation/migrations'
import { TeamStore } from '../../../../../../src/main/apps/team/store'
import {
  MIGRATION_NAMESPACE as TEAM_NS,
  migrations as teamMigrations,
} from '../../../../../../src/main/apps/team/migrations'
import {
  createOfficeAuthority,
  type OfficeAuthority,
} from '../../../../../../src/main/apps/runtime/federation/authority/office-authority'
import type { ReadMemberHistory } from '../../../../../../src/main/apps/runtime/federation/authority/history-fetch'
import { SELF_NODE_ID } from '../../../../../../src/shared/apps/team-types'
import type { TeamMember } from '../../../../../../src/main/apps/team'
import type { FederationMessage } from '../../../../../../src/main/apps/runtime/federation/types'

const OFFICE = 'office-relay'
const EPOCH = 'epoch-1'
const HOST = 'H'
const VIEWER = 'V' // joiner that asks
const OWNER = 'O' // joiner that owns the member + serves its transcript

const TRANSCRIPT = [
  { seq: 1, role: 'user', content: 'hello', ts: 1 },
  { seq: 2, role: 'assistant', content: 'hi from the owner', ts: 2 },
]

interface Node {
  id: string
  dbm: DatabaseManager
  fed: FederationStore
  team: TeamStore
  office: OfficeAuthority
}

describe('host-relayed member history (joiner → joiner via the host hop)', () => {
  const created: DatabaseManager[] = []
  afterEach(() => {
    for (const d of created) d.closeAll()
    created.length = 0
    vi.useRealTimers()
  })

  /**
   * Build the 3-node star. `ownerMemberRow` controls how the OWNER's own store
   * sees the member (production: SELF; a stale-roster case: someone else).
   * `dropToOwner` silences the host→owner leg to simulate an unresponsive owner.
   */
  function build(opts?: { ownerSelfOwned?: boolean; dropToOwner?: boolean }) {
    const ownerSelfOwned = opts?.ownerSelfOwned ?? true
    const registry = new Map<string, Node>()

    const route = (fromId: string, to: string, frame: FederationMessage) => {
      const target = fromId === HOST ? to : HOST
      if (opts?.dropToOwner && fromId === HOST && target === OWNER) return
      const from = (frame as { fromNode?: string }).fromNode ?? 'unknown'
      registry.get(target)?.office.handle(from, frame as never)
    }

    for (const id of [HOST, VIEWER, OWNER]) {
      const dbm = createDatabaseManager(':memory:')
      created.push(dbm)
      const db = dbm.getAppDatabase()
      dbm.runMigrations(db, FED_NS, fedMigrations)
      dbm.runMigrations(db, TEAM_NS, teamMigrations)
      const fed = new FederationStore(db)
      const auth = new AuthorityStore(db)
      const team = new TeamStore(db)
      for (const peer of [HOST, VIEWER, OWNER]) {
        fed.upsertNode({
          nodeId: peer, officeId: OFFICE, identity: peer, displayName: peer,
          joinedAt: peer === HOST ? 1 : 2, lastSeen: 0, status: 'online',
        })
      }
      auth.patchAuthorityState(OFFICE, { term: 1, authorityNodeId: HOST, rosterEpoch: 1 }, 0)
      const office = createOfficeAuthority({
        officeId: OFFICE,
        selfNodeId: id,
        federationStore: fed,
        authorityStore: auth,
        teamStore: team,
        send: (to, frame) => route(id, to, frame as FederationMessage),
        broadcast: () => {},
        now: () => 0,
        getCurrentRunEpoch: () => ({ teamId: OFFICE, epochId: EPOCH }),
        getOwnerStatus: () => 'idle',
        reassignTask: () => {},
        applyMemberWrite: () => {},
        onBecomeAuthority: () => {},
        onAuthorityChange: () => {},
        resolveArtifactBytes: async () => null,
        // Only the OWNER can serve; host/viewer readers must never be consulted.
        readMemberHistory: (id === OWNER ? () => TRANSCRIPT : () => null) as ReadMemberHistory,
        schedule: () => () => {},
        jitter: () => 0,
      })
      registry.set(id, { id, dbm, fed, team, office })
    }
    const nodes = Object.fromEntries(registry) as Record<string, Node>

    // Roster: member `wkr` owned by O — stored ABSOLUTE on host/viewer, and
    // SELF-relative on the owner (production materialization shape).
    const row = (ownerNodeId: string): TeamMember => ({
      teamId: OFFICE, appId: 'wkr', memberName: 'wkr', role: 'worker',
      isLead: false, aiProvisioned: false, addedAt: 1, ownerNodeId,
      origin: ownerNodeId === SELF_NODE_ID ? 'local' : 'remote',
      memberIdentity: 'wkr', scopeJson: null,
    })
    nodes[HOST].team.addMember(row(OWNER))
    nodes[VIEWER].team.addMember(row(OWNER))
    nodes[OWNER].team.addMember(row(ownerSelfOwned ? SELF_NODE_ID : 'someone-else'))
    return nodes
  }

  it('relay served: a joiner pulls a peer joiner\u2019s member transcript through the host', async () => {
    const nodes = build()
    const got = await nodes.V.office.history.fetch({
      ownerNodeId: OWNER, teamId: OFFICE, appId: 'wkr', epochId: EPOCH,
    })
    expect(got).toEqual(TRANSCRIPT)
    // Both pending tables settled (viewer's request + host's relay leg).
    expect(nodes.V.office.history.pendingCount()).toBe(0)
    expect(nodes.H.office.history.pendingCount()).toBe(0)
  })

  it('one hop max: an owner that does not own the member refuses instead of re-relaying', async () => {
    const nodes = build({ ownerSelfOwned: false })
    await expect(
      nodes.V.office.history.fetch({
        ownerNodeId: OWNER, teamId: OFFICE, appId: 'wkr', epochId: EPOCH,
      })
    ).rejects.toThrow('history-not-owned')
    expect(nodes.H.office.history.pendingCount()).toBe(0)
  })

  it('fail-fast: a suspect owner rejects immediately with history-owner-unreachable', async () => {
    const nodes = build()
    nodes.H.fed.upsertNode({
      nodeId: OWNER, officeId: OFFICE, identity: OWNER, displayName: OWNER,
      joinedAt: 2, lastSeen: 0, status: 'suspect',
    })
    await expect(
      nodes.V.office.history.fetch({
        ownerNodeId: OWNER, teamId: OFFICE, appId: 'wkr', epochId: EPOCH,
      })
    ).rejects.toThrow('history-owner-unreachable')
    expect(nodes.H.office.history.pendingCount()).toBe(0)
  })

  it('relay timeout: an unresponsive owner surfaces history-relay-failed before the requester deadline', async () => {
    vi.useFakeTimers()
    const nodes = build({ dropToOwner: true })
    const p = nodes.V.office.history.fetch({
      ownerNodeId: OWNER, teamId: OFFICE, appId: 'wkr', epochId: EPOCH,
    })
    const guarded = p.catch((e: Error) => e)
    // The host's relay leg times out BEFORE the viewer's 8s deadline and reports
    // a definite error code (not a silent viewer-side timeout).
    await vi.advanceTimersByTimeAsync(7000)
    const err = await guarded
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('history-relay-failed')
    expect(nodes.V.office.history.pendingCount()).toBe(0)
    expect(nodes.H.office.history.pendingCount()).toBe(0)
  })
})
