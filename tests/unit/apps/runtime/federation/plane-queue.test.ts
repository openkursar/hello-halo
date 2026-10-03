import { describe, it, expect } from 'vitest'
import { PlaneQueue } from '../../../../../src/main/apps/runtime/federation/plane-queue'
import { federationPlaneSpec } from '../../../../../src/shared/federation/planes'
import { framePlane } from '../../../../../src/main/apps/runtime/federation/types'
import type { FederationMessage } from '../../../../../src/main/apps/runtime/federation/types'

describe('outbound plane queue', () => {
  it('drains control first and sheds only within the overflowing plane', () => {
    const q = new PlaneQueue<string>()
    q.push('artifact', 'a1', () => 0)
    q.push('feed', 'f1', () => 10)
    q.push('control', 'c1', () => 0)
    q.push('stream', 's1', () => 0)
    const out: string[] = []
    q.drain((item) => out.push(item))
    expect(out).toEqual(['c1', 's1', 'f1', 'a1'])
    expect(q.size('control')).toBe(0)
  })

  it('bounds the feed plane by size, dropping its own oldest', () => {
    const q = new PlaneQueue<string>()
    const half = federationPlaneSpec('feed').capBytes / 2 + 1
    q.push('control', 'c', () => 0)
    expect(q.push('feed', 'f1', () => half)).toBe(0)
    expect(q.push('feed', 'f2', () => half)).toBe(1)
    expect(q.size('feed')).toBe(1)
    expect(q.size('control')).toBe(1)
  })

  it('transcript frames ride the feed plane; ctrl-feed frames (wakes) stay on control', () => {
    const session = { kind: 'feed-entries', officeId: 'o', feedKey: 'node\u0000session:app-chat:a:team:o:e', entries: [], upToSeq: 0, more: false, truncatedBeforeSeq: 0 }
    const ctrl = { ...session, feedKey: 'node\u0000ctrl:node-2' }
    expect(framePlane(session as FederationMessage)).toBe('feed')
    expect(framePlane(ctrl as FederationMessage)).toBe('control')
    expect(framePlane({ kind: 'feed-digest', officeId: 'o', feeds: [] } as FederationMessage)).toBe('feed')
  })
})
