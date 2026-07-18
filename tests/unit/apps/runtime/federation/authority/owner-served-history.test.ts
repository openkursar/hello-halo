/**
 * Owner-served remote-member run history (cross-node read pull).
 *
 * A member's transcript lives ONLY on the node that owns that member. A viewer that
 * wants to read a remote member's history asks the OWNING node on demand; the owner
 * authorizes the request (serves only members it actually owns) and replies over the
 * history plane, exactly like the artifact plane's owner-served authorization.
 *
 * Two real OfficeAuthority instances over a synchronous node-id hub (the office-
 * authority integration pattern). The OWNER injects a `readMemberHistory` reader so
 * this suite never touches app-chat. Proven end-to-end:
 *   - served: viewer pulls an owned member's transcript → resolves with the bytes;
 *   - not-owned: a request for a member the receiver does NOT own → rejects with the
 *     technical `history-not-owned` code (never user-facing), and the reader is never
 *     consulted (no cross-node transcript read);
 *   - not-found: an owned member with nothing to serve → rejects `history-not-found`;
 *   - the reject is fail-closed and carries only a TECHNICAL code — no transcript, no
 *     user-facing text.
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
import type { ReadMemberHistory } from '../../../../../../src/main/apps/runtime/federation/authority/history-fetch'
import type { TeamMember } from '../../../../../../src/main/apps/team'
import type { FederationMessage } from '../../../../../../src/main/apps/runtime/federation/types'

const OFFICE = 'office-hist'
const EPOCH = 'epoch-1'
const VIEWER = 'V' // node that asks
const OWNER = 'O' // node that owns the member + serves its transcript

function member(appId: string, ownerNodeId: string): TeamMember {
  return {
    teamId: OFFICE,
    appId,
    memberName: appId,
    role: 'worker',
    isLead: false,
    aiProvisioned: false,
    addedAt: 1,
    ownerNodeId,
    origin: ownerNodeId === OWNER ? 'local' : 'remote',
    memberIdentity: appId,
    scopeJson: null,
  }
}

interface Node {
  id: string
  dbm: DatabaseManager
  team: TeamStore
  office: OfficeAuthority
}

describe('C-1 — owner-served remote member history (owner authorizes + serves)', () => {
  const created: DatabaseManager[] = []
  afterEach(() => {
    for (const d of created) d.closeAll()
    created.length = 0
  })

  /**
   * Build a 2-node hub. `readByOwner` is the OWNER's injected transcript reader;
   * `ownerReaderCalls` records every (appId, epochId) the reader was asked for, so a
   * test can assert the reader is NOT consulted on an unauthorized request.
   */
  function build(readByOwner: ReadMemberHistory) {
    const ids = [VIEWER, OWNER]
    const registry = new Map<string, Node>()

    const route = (to: string, frame: FederationMessage) => {
      const from = (frame as { fromNode?: string }).fromNode ?? 'unknown'
      registry.get(to)?.office.handle(from, frame as never)
    }

    for (const id of ids) {
      const dbm = createDatabaseManager(':memory:')
      created.push(dbm)
      const db = dbm.getAppDatabase()
      dbm.runMigrations(db, FED_NS, fedMigrations)
      dbm.runMigrations(db, TEAM_NS, teamMigrations)
      const fed = new FederationStore(db)
      const auth = new AuthorityStore(db)
      const team = new TeamStore(db)
      for (const peer of ids) {
        fed.upsertNode({
          nodeId: peer, officeId: OFFICE, identity: peer, displayName: peer,
          joinedAt: peer === VIEWER ? 1 : 2, lastSeen: 0, status: 'online',
        })
      }
      auth.patchAuthorityState(OFFICE, { term: 1, authorityNodeId: OWNER, rosterEpoch: 1 }, 0)
      const office = createOfficeAuthority({
        officeId: OFFICE,
        selfNodeId: id,
        federationStore: fed,
        authorityStore: auth,
        teamStore: team,
        send: (to, frame) => route(to, frame as FederationMessage),
        broadcast: () => {},
        now: () => 0,
        getCurrentRunEpoch: () => ({ teamId: OFFICE, epochId: EPOCH }),
        getOwnerStatus: () => 'idle',
        reassignTask: () => {},
        applyMemberWrite: () => {},
        onBecomeAuthority: () => {},
        onAuthorityChange: () => {},
        resolveArtifactBytes: async () => null,
        // Only the OWNER serves transcripts; the viewer's reader is never reached.
        readMemberHistory: id === OWNER ? readByOwner : () => null,
        schedule: () => () => {},
        jitter: () => 0,
      })
      registry.set(id, { id, dbm, team, office })
    }
    const nodes = Object.fromEntries(registry) as Record<string, Node>
    for (const id of ids) nodes[id].team.addMember(member('wkr', OWNER))
    return nodes
  }

  it('served: a viewer pulls an OWNED member transcript from the owner', async () => {
    const transcript = [
      { seq: 1, role: 'user', content: 'hello', ts: 1 },
      { seq: 2, role: 'assistant', content: 'hi there', ts: 2 },
    ]
    const nodes = build(() => transcript)

    const got = await nodes.V.office.history.fetch({
      ownerNodeId: OWNER,
      teamId: OFFICE,
      appId: 'wkr',
      epochId: EPOCH,
    })
    expect(got).toEqual(transcript)
    expect(nodes.V.office.history.pendingCount()).toBe(0) // settled
  })

  it('served: an assistant message carries its full thoughts/tool trace to the viewer', async () => {
    // The owner-served transcript must carry the thinking + tool trace so a remote
    // viewer's post-run backfill shows the SAME thoughts the live relay did — not
    // just the final text (a finished member otherwise loses its thinking on backfill).
    const transcript = [
      { seq: 1, role: 'user', content: 'go', ts: 1 },
      {
        seq: 2,
        role: 'assistant',
        content: 'done',
        thoughts: [
          { id: 't1', type: 'thinking' as const, content: 'let me plan', timestamp: '2026-07-15T00:00:00Z' },
          {
            id: 't2',
            type: 'tool_use' as const,
            content: 'write the file',
            timestamp: '2026-07-15T00:00:01Z',
            toolName: 'write_file',
          },
        ],
        thoughtsSummary: { count: 2, types: { thinking: 1, tool_use: 1 } },
        ts: 2,
      },
    ]
    const nodes = build(() => transcript)

    const got = await nodes.V.office.history.fetch({
      ownerNodeId: OWNER,
      teamId: OFFICE,
      appId: 'wkr',
      epochId: EPOCH,
    })
    expect(got).toEqual(transcript)
    expect((got[1] as { thoughts?: unknown[] }).thoughts).toHaveLength(2)
  })

  it('incremental: sinceSeq returns only the tail newer than the cached watermark', async () => {
    const transcript = [
      { seq: 1, role: 'user', content: 'a', ts: 1 },
      { seq: 2, role: 'assistant', content: 'b', ts: 2 },
      { seq: 3, role: 'user', content: 'c', ts: 3 },
    ]
    const nodes = build(() => transcript)

    // Viewer already holds up to seq 2 → owner sends only seq 3 (the delta).
    const tail = await nodes.V.office.history.fetch({
      ownerNodeId: OWNER,
      teamId: OFFICE,
      appId: 'wkr',
      epochId: EPOCH,
      sinceSeq: 2,
    })
    expect(tail).toEqual([{ seq: 3, role: 'user', content: 'c', ts: 3 }])

    // No watermark → the whole transcript, unchanged.
    const full = await nodes.V.office.history.fetch({
      ownerNodeId: OWNER,
      teamId: OFFICE,
      appId: 'wkr',
      epochId: EPOCH,
    })
    expect(full).toEqual(transcript)
  })

  it('not-owned: a request for a member the receiver does NOT own is refused (reader never consulted)', async () => {
    const readerArgs: Array<{ appId: string }> = []
    const nodes = build((args) => {
      readerArgs.push({ appId: args.appId })
      return [{ seq: 1, role: 'user', content: 'should-never-be-served' }]
    })
    // Ask the owner for a member it does NOT own (`ghost` is in nobody's roster on O).
    await expect(
      nodes.V.office.history.fetch({
        ownerNodeId: OWNER,
        teamId: OFFICE,
        appId: 'ghost',
        epochId: EPOCH,
      })
    ).rejects.toThrow('history-not-owned')
    expect(readerArgs).toEqual([])
  })

  it('not-found: an owned member with nothing to serve rejects with the not-found code', async () => {
    const nodes = build(() => null) // owned, but reader has nothing
    await expect(
      nodes.V.office.history.fetch({
        ownerNodeId: OWNER,
        teamId: OFFICE,
        appId: 'wkr',
        epochId: EPOCH,
      })
    ).rejects.toThrow('history-not-found')
  })

  it('the reject error is a TECHNICAL code only — no transcript leaks on refusal', async () => {
    const nodes = build(() => [{ seq: 1, role: 'assistant', content: 'secret' }])
    let caught: Error | null = null
    try {
      await nodes.V.office.history.fetch({
        ownerNodeId: OWNER, teamId: OFFICE, appId: 'ghost', epochId: EPOCH,
      })
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught!.message).toBe('history-not-owned')
    expect(caught!.message).not.toContain('secret')
  })
})
