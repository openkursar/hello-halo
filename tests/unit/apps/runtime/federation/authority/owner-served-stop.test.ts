/**
 * Owner-served turn abort (cross-node stop).
 *
 * A member's turn runs ONLY in the process that owns that member, so a stop
 * pressed on a viewer's machine has to travel: aborting locally would look for a
 * session that was never there and report success while the member kept working
 * — the defect this plane exists to close. The owner authorizes the request
 * (aborts only members it actually owns) and answers over the stop plane.
 *
 * Two real OfficeAuthority instances over a synchronous node-id hub (the
 * office-authority integration pattern), plus a 3-node star for the host relay.
 * The OWNER injects a `stopMemberTurn` aborter so this suite never touches
 * app-chat. Proven end-to-end:
 *   - served: a viewer's stop aborts an owned member's running turn;
 *   - "nothing was running" comes back as `false`, an ANSWER rather than a
 *     failure, so the UI never reports an error for a turn that just ended;
 *   - not-owned: refused with the technical `stop-not-owned` code, and the
 *     aborter is never consulted (no cross-node reach into someone's session);
 *   - a retransmitted request aborts at most once — a second abort would reach
 *     past the turn the user meant into the one after it;
 *   - host relay: a joiner can stop a member owned by a PEER joiner.
 */

import { describe, it, expect, afterEach } from 'vitest'
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
import type { StopMemberTurn } from '../../../../../../src/main/apps/runtime/federation/authority/stop-turn'
import { SELF_NODE_ID } from '../../../../../../src/shared/apps/team-types'
import type { TeamMember } from '../../../../../../src/main/apps/team'
import type { FederationMessage } from '../../../../../../src/main/apps/runtime/federation/types'

const OFFICE = 'office-stop'
const EPOCH = 'epoch-1'
const HOST = 'H'
const VIEWER = 'V' // node that presses stop
const OWNER = 'O' // node that runs the member's turn

interface Node {
  id: string
  dbm: DatabaseManager
  team: TeamStore
  office: OfficeAuthority
}

function memberRow(ownerNodeId: string): TeamMember {
  return {
    teamId: OFFICE,
    appId: 'wkr',
    memberName: 'wkr',
    role: 'worker',
    isLead: false,
    aiProvisioned: false,
    addedAt: 1,
    ownerNodeId,
    origin: ownerNodeId === SELF_NODE_ID ? 'local' : 'remote',
    memberIdentity: 'wkr',
    scopeJson: null,
  }
}

describe('owner-served turn abort (a stop travels to the machine running the turn)', () => {
  const created: DatabaseManager[] = []
  afterEach(() => {
    for (const d of created) d.closeAll()
    created.length = 0
  })

  /**
   * Build an N-node hub. `star` routes every non-host send to the host first
   * (LanMeshLink client semantics), which is what forces the relay hop.
   */
  function build(opts: { ids: string[]; star?: boolean; stopByOwner: StopMemberTurn }) {
    const registry = new Map<string, Node>()

    const route = (fromId: string, to: string, frame: FederationMessage) => {
      const target = opts.star && fromId !== HOST ? HOST : to
      const from = (frame as { fromNode?: string }).fromNode ?? 'unknown'
      registry.get(target)?.office.handle(from, frame as never)
    }

    for (const id of opts.ids) {
      const dbm = createDatabaseManager(':memory:')
      created.push(dbm)
      const db = dbm.getAppDatabase()
      dbm.runMigrations(db, FED_NS, fedMigrations)
      dbm.runMigrations(db, TEAM_NS, teamMigrations)
      const fed = new FederationStore(db)
      const auth = new AuthorityStore(db)
      const team = new TeamStore(db)
      for (const peer of opts.ids) {
        fed.upsertNode({
          nodeId: peer, officeId: OFFICE, identity: peer, displayName: peer,
          joinedAt: peer === VIEWER ? 1 : 2, lastSeen: 0, status: 'online',
          advertisedUrl: null,
        })
      }
      auth.patchAuthorityState(OFFICE, { term: 1, authorityNodeId: opts.star ? HOST : OWNER, rosterEpoch: 1 }, 0)
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
        // Only the OWNER can abort; every other node's aborter must stay unused.
        stopMemberTurn: id === OWNER ? opts.stopByOwner : () => Promise.resolve(false),
        schedule: () => () => {},
        jitter: () => 0,
      })
      registry.set(id, { id, dbm, team, office })
    }
    const nodes = Object.fromEntries(registry) as Record<string, Node>
    // The owner stores the member SELF-relative; everyone else stores it absolute.
    for (const id of opts.ids) {
      nodes[id].team.addMember(memberRow(id === OWNER ? SELF_NODE_ID : OWNER))
    }
    return nodes
  }

  it('served: a viewer stops a turn running on the owner', async () => {
    const asked: Array<{ appId: string; epochId: string; fromNode: string }> = []
    const nodes = build({
      ids: [VIEWER, OWNER],
      stopByOwner: async ({ appId, epochId, requester }) => {
        asked.push({ appId, epochId, fromNode: requester.nodeId })
        return true
      },
    })

    const stopped = await nodes.V.office.stopTurn.stop({
      ownerNodeId: OWNER,
      teamId: OFFICE,
      appId: 'wkr',
      epochId: EPOCH,
    })

    expect(stopped).toBe(true)
    expect(asked).toEqual([{ appId: 'wkr', epochId: EPOCH, fromNode: VIEWER }])
    expect(nodes.V.office.stopTurn.pendingCount()).toBe(0)
  })

  it('nothing was running: answered false, not raised as a failure', async () => {
    const nodes = build({ ids: [VIEWER, OWNER], stopByOwner: async () => false })

    await expect(
      nodes.V.office.stopTurn.stop({ ownerNodeId: OWNER, teamId: OFFICE, appId: 'wkr', epochId: EPOCH })
    ).resolves.toBe(false)
  })

  it('not-owned: a stop aimed at a member the receiver does not own is refused, aborter untouched', async () => {
    let aborterCalls = 0
    const nodes = build({
      ids: [VIEWER, OWNER],
      stopByOwner: async () => {
        aborterCalls++
        return true
      },
    })

    // Address the VIEWER as if it owned the member. It does not, and with no
    // third node to relay to it must refuse rather than reach anywhere.
    await expect(
      nodes.O.office.stopTurn.stop({ ownerNodeId: VIEWER, teamId: OFFICE, appId: 'wkr', epochId: EPOCH })
    ).rejects.toThrow('stop-not-owned')
    expect(aborterCalls).toBe(0)
  })

  it('a retransmitted request aborts at most once', async () => {
    let aborterCalls = 0
    const nodes = build({
      ids: [VIEWER, OWNER],
      stopByOwner: async () => {
        aborterCalls++
        return true
      },
    })

    const frame = {
      kind: 'stop-turn-request' as const,
      officeId: OFFICE,
      fromNode: VIEWER,
      teamId: OFFICE,
      appId: 'wkr',
      epochId: EPOCH,
      fid: 'fid-repeat',
    }
    nodes.O.office.stopTurn.handleRequest(VIEWER, frame)
    nodes.O.office.stopTurn.handleRequest(VIEWER, frame)
    await Promise.resolve()

    expect(aborterCalls).toBe(1)
  })

  it('host relay: a joiner stops a member owned by a PEER joiner', async () => {
    const asked: string[] = []
    const nodes = build({
      ids: [HOST, VIEWER, OWNER],
      star: true,
      stopByOwner: async ({ requester }) => {
        // The forwarded frame keeps the TRUE requester, not the relaying host —
        // that is what a future scope filter would have to judge.
        asked.push(requester.nodeId)
        return true
      },
    })

    const stopped = await nodes.V.office.stopTurn.stop({
      ownerNodeId: OWNER,
      teamId: OFFICE,
      appId: 'wkr',
      epochId: EPOCH,
    })

    expect(stopped).toBe(true)
    expect(asked).toEqual([VIEWER])
  })
})
