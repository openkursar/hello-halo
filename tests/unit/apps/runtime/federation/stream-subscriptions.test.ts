/**
 * Live streams by subscription: a viewer gets a session's stream only while
 * subscribed. Subscriptions are soft state, re-declared after every (re)join.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../src/main/platform/store/types'
import { FederationStore } from '../../../../../src/main/apps/federation/store'
import { initFederationStore, shutdownFederationStore } from '../../../../../src/main/apps/federation'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE as TEAM_NS, migrations as teamMigrations } from '../../../../../src/main/apps/team/migrations'
import { createFederationManager, type FederationManager } from '../../../../../src/main/apps/runtime/federation/manager'
import {
  createStreamRecipients,
  createStreamWatch,
  STREAM_UNSUBSCRIBE_GRACE_MS,
} from '../../../../../src/main/apps/runtime/federation/stream-subscriptions'
import { FEDERATION_PROTOCOL_VERSION } from '../../../../../src/main/apps/runtime/federation/protocol-m2'
import { DEFAULT_OFFICE_SCOPE } from '../../../../../src/main/apps/federation/types'
import type { FederationMessage, StreamFramesFrame } from '../../../../../src/main/apps/runtime/federation'
import type { StreamSubscribeFrame } from '../../../../../src/main/apps/runtime/federation/protocol-m2'
import { buildTeamSessionKey } from '../../../../../src/shared/apps/im-keys'

const OFFICE = 'office-stream'
const HOST = 'node-host'
const OWNER = 'node-owner'
const VIEWER = 'node-viewer'
const OTHER = 'node-other'
const TOKEN = 't'
const SESSION = buildTeamSessionKey('app-owner', OFFICE, 'epoch-1')

describe('stream recipients (authority side)', () => {
  it('a node gets only what it subscribed', () => {
    const r = createStreamRecipients()
    expect(r.wants('n', 's1')).toBe(false)
    r.subscribe('n', 's1')
    expect(r.wants('n', 's1')).toBe(true)
    expect(r.wants('n', 's2')).toBe(false)
    expect(r.wants('other', 's1')).toBe(false)
    r.dropNode('n')
    expect(r.wants('n', 's1')).toBe(false)
  })
})

describe('stream watch (viewer side)', () => {
  it('subscribes once, releases after the grace period, and re-declares on resend', () => {
    const sent: string[] = []
    const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = []
    const watch = createStreamWatch({
      officeId: OFFICE,
      selfNodeId: VIEWER,
      send: (f) => sent.push(`${f.kind}:${f.sessionKey}`),
      schedule: (ms, fn) => {
        const t = { ms, fn, cancelled: false }
        timers.push(t)
        return () => { t.cancelled = true }
      },
    })
    watch.setWatched(new Set(['a', 'b']))
    watch.setWatched(new Set(['a', 'b']))
    expect(sent).toEqual(['stream-subscribe:a', 'stream-subscribe:b'])

    watch.setWatched(new Set(['a']))
    expect(timers[0].ms).toBe(STREAM_UNSUBSCRIBE_GRACE_MS)
    // Reopened within the grace period: no churn.
    watch.setWatched(new Set(['a', 'b']))
    expect(timers[0].cancelled).toBe(true)
    watch.setWatched(new Set(['a']))
    timers[1].fn()
    expect(sent.at(-1)).toBe('stream-unsubscribe:b')

    // A new authority after an election knows nothing: every held session is re-declared.
    sent.length = 0
    watch.resend()
    expect(sent).toEqual(['stream-subscribe:a'])
  })
})

describe('authority forwards streams to subscribers only', () => {
  let dbManager: DatabaseManager
  let manager: FederationManager
  let streamTargets: string[][]
  let channelsTo: Map<string, string[]>

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    initFederationStore({ db: dbManager })
    dbManager.runMigrations(db, TEAM_NS, teamMigrations)
    streamTargets = []
    channelsTo = new Map()
    manager = createFederationManager({
      hostSend: () => true,
      hostSendMany: (clients, frame) => {
        if (frame.kind !== 'stream-frames') return []
        const channels = frame.frames.map((f) => f.channel)
        streamTargets.push([...clients])
        for (const client of clients) channelsTo.set(client, [...(channelsTo.get(client) ?? []), ...channels])
        return []
      },
      hostListOfficeClients: () => [`c-${OWNER}`, `c-${VIEWER}`, `c-${OTHER}`],
      federationStore: new FederationStore(db),
      teamStore: new TeamStore(db),
      verifyCredential: (token) => (token === TOKEN ? { officeId: OFFICE, scope: DEFAULT_OFFICE_SCOPE } : null),
      getLocalNodeId: () => HOST,
      getSessionIdentity: (clientId) => clientId.slice(2),
    })
    manager.hostOffice(OFFICE)
    const join = (node: string, members: Array<{ appId: string }> = []) =>
      manager.handleHostInbound({
        clientId: `c-${node}`,
        officeId: OFFICE,
        frame: {
          kind: 'join-request', officeId: OFFICE, fromNode: node, identityId: node, displayName: node,
          credentialToken: TOKEN, pv: FEDERATION_PROTOCOL_VERSION,
          bringMembers: members.map((m) => ({ ...m, memberName: m.appId, role: 'r', spaceId: 's' })),
        } as FederationMessage,
      })
    join(OWNER, [{ appId: 'app-owner' }])
    join(VIEWER)
    join(OTHER)
  })

  afterEach(() => {
    manager.stopAll()
    shutdownFederationStore()
    dbManager.closeAll()
  })

  /** The clients that received this batch. */
  function stream(seq: number): string[] {
    streamTargets = []
    const batch: StreamFramesFrame = {
      kind: 'stream-frames', officeId: OFFICE, sessionKey: SESSION, baseSeq: seq, originRun: 'r',
      frames: [{ seq, kind: 'milestone', channel: 'agent:message', spaceId: 's', payload: { delta: 'x' } }],
    }
    manager.handleHostInbound({ clientId: `c-${OWNER}`, officeId: OFFICE, frame: batch })
    return streamTargets.flat()
  }

  function subscribe(kind: StreamSubscribeFrame['kind']): void {
    manager.handleHostInbound({
      clientId: `c-${VIEWER}`,
      officeId: OFFICE,
      frame: { kind, officeId: OFFICE, fromNode: VIEWER, sessionKey: SESSION, fid: `${kind}-1` } as FederationMessage,
    })
  }

  it('a viewer gets the stream only while subscribed; others and the producer never', () => {
    expect(stream(1)).toEqual([])
    subscribe('stream-subscribe')
    expect(stream(2)).toEqual([`c-${VIEWER}`])
    subscribe('stream-unsubscribe')
    expect(stream(3)).toEqual([])
  })

  it('a node that does not show the session still gets its status events, never its detail', () => {
    subscribe('stream-subscribe')
    manager.handleHostInbound({
      clientId: `c-${OWNER}`,
      officeId: OFFICE,
      frame: {
        kind: 'stream-frames', officeId: OFFICE, sessionKey: SESSION, baseSeq: 1, originRun: 'r',
        frames: [
          { seq: 1, kind: 'milestone', channel: 'agent:turn-start', spaceId: 's', payload: {} },
          { seq: 2, kind: 'incremental', channel: 'agent:thought-delta', spaceId: 's', payload: { delta: 'x' } },
          { seq: 3, kind: 'milestone', channel: 'agent:complete', spaceId: 's', payload: {} },
        ],
      } as StreamFramesFrame,
    })
    expect(channelsTo.get(`c-${VIEWER}`)).toEqual(['agent:turn-start', 'agent:thought-delta', 'agent:complete'])
    expect(channelsTo.get(`c-${OTHER}`)).toEqual(['agent:turn-start', 'agent:complete'])
    expect(channelsTo.has(`c-${OWNER}`)).toBe(false)
  })

  it('a subscription for another office’s session is ignored', () => {
    manager.handleHostInbound({
      clientId: `c-${VIEWER}`,
      officeId: OFFICE,
      frame: { kind: 'stream-subscribe', officeId: OFFICE, fromNode: VIEWER, sessionKey: buildTeamSessionKey('x', 'other-office', 'e'), fid: 'f' } as FederationMessage,
    })
    expect(stream(1)).toEqual([])
  })
})
