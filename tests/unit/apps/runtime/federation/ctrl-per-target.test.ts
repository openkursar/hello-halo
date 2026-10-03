/**
 * Wakes on per-target ctrl feeds. An authority addresses each node on
 * `ctrl:<node>`, which only that node reads. A dropped wake frame is recovered
 * by the retransmit backstop within one tick.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../src/main/platform/store/types'
import { FeedStore } from '../../../../../src/main/apps/federation/feed-store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../../src/main/apps/federation/migrations'
import { createCtrlFeed, ctrlTargetKind, type CtrlFeed } from '../../../../../src/main/apps/runtime/federation/ctrl-feed'
import { feedIdKey, type FeedSyncFrame } from '../../../../../src/main/apps/runtime/federation/log/types'
import type { SerializedWakeRequest } from '../../../../../src/main/apps/runtime/federation/types'

const OFFICE = 'office-1'
const AUTH = 'node-authority'
const A = 'node-a'
const B = 'node-b'

const request = { appId: 'a', spaceId: 's', message: 'm', conversationId: 'c', teamContext: {} } as unknown as SerializedWakeRequest

describe('ctrl per-target feeds', () => {
  const dbs: DatabaseManager[] = []
  afterEach(() => dbs.splice(0).forEach((d) => d.closeAll()))

  function store(): FeedStore {
    const dbm = createDatabaseManager(':memory:')
    dbm.runMigrations(dbm.getAppDatabase(), MIGRATION_NAMESPACE, migrations)
    dbs.push(dbm)
    return new FeedStore(dbm.getAppDatabase())
  }

  function build() {
    const nodes = new Map<string, CtrlFeed>()
    const framesTo = new Map<string, FeedSyncFrame[]>([[A, []], [B, []]])
    const wakes = new Map<string, string[]>([[A, []], [B, []]])
    let drop: ((to: string, f: FeedSyncFrame) => boolean) | null = null
    const deliver = (to: string, from: string, frame: FeedSyncFrame) => {
      if (drop?.(to, frame)) {
        drop = null
        return
      }
      framesTo.get(to)?.push(frame)
      nodes.get(to)?.handleFrame(from, JSON.parse(JSON.stringify(frame)))
    }
    const authStore = store()
    nodes.set(AUTH, createCtrlFeed({
      officeId: OFFICE, selfNodeId: AUTH, feedStore: authStore,
      sendToPeer: (peer, f) => deliver(peer, AUTH, f),
      onWake: () => {}, onTurnComplete: () => {},
      retransmitIntervalMs: 0,
    }))
    for (const node of [A, B]) {
      nodes.set(node, createCtrlFeed({
        officeId: OFFICE, selfNodeId: node, feedStore: store(),
        sendToPeer: (peer, f) => deliver(peer, node, f),
        onWake: (m) => wakes.get(node)!.push(m.correlationId),
        onTurnComplete: () => {},
        retransmitIntervalMs: 0,
      }))
    }
    nodes.get(A)!.subscribePeer(AUTH)
    nodes.get(B)!.subscribePeer(AUTH)
    return { auth: nodes.get(AUTH)!, authStore, framesTo, wakes, dropNext: (p: typeof drop) => { drop = p } }
  }

  it('a wake rides its target’s own feed; another node never sees it', () => {
    const h = build()
    h.auth.publishWake(A, 'to-new', request)
    h.auth.publishWake(B, 'to-old', request)
    expect(h.wakes.get(A)).toEqual(['to-new'])
    expect(h.wakes.get(B)).toEqual(['to-old'])
    // Bytes that reached the other node: nothing of the wake addressed elsewhere.
    const oldEntries = h.framesTo.get(B)!.flatMap((f) => (f.kind === 'feed-entries' ? f.entries : []))
    expect(oldEntries.map((e) => (e.payload as { correlationId: string }).correlationId)).toEqual(['to-old'])
    const targetKey = feedIdKey({ officeId: OFFICE, author: AUTH, kind: ctrlTargetKind(A) })
    expect(h.authStore.getMaxSeq(OFFICE, targetKey)).toBe(1)
    expect(h.auth.deliveredUpTo(A)).toBe(1)
  })

  it('a dropped per-target wake is delivered by the next retransmit tick', () => {
    const h = build()
    h.dropNext((to, f) => to === A && f.kind === 'feed-entries')
    h.auth.publishWake(A, 'lost-once', request)
    expect(h.wakes.get(A)).toEqual([])
    h.auth.retransmitTick()
    expect(h.wakes.get(A)).toEqual(['lost-once'])
  })

  it('a target’s feed is pruned once that target acked, regardless of other peers', () => {
    const h = build()
    h.auth.publishWake(A, 'w1', request)
    h.auth.retransmitTick()
    const targetKey = feedIdKey({ officeId: OFFICE, author: AUTH, kind: ctrlTargetKind(A) })
    expect(h.authStore.listAfter(OFFICE, targetKey, 0, 10)).toHaveLength(0)
  })
})
