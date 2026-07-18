/**
 * Unit tests for the remote-busy overlay — the host-authority view of members
 * whose turn runs on a REMOTE owner (a wake was sent, its turn-complete has not
 * returned). Each mutation must signal a roster refresh so viewers animate the
 * working/idle transition, and — critically — the TTL backstop must NOT evict
 * silently: a stale 'working' pulse that lingers because a turn-complete was lost
 * has to self-correct instead of latching until an unrelated event.
 */

import { describe, it, expect, vi } from 'vitest'
import { createRemoteBusyOverlay } from '../../../../../src/main/apps/runtime/federation/remote-busy-overlay'

describe('remote-busy overlay', () => {
  it('marks a member busy and clears on turn-complete, signalling each change', () => {
    const changes: string[] = []
    const overlay = createRemoteBusyOverlay((officeId) => changes.push(officeId))

    overlay.mark('c1', 'office-1', 'app-1', 'node-b')
    expect(overlay.isBusy('app-1')).toBe(true)
    expect(overlay.ownerNodeId('c1')).toBe('node-b')
    expect(changes).toEqual(['office-1']) // mark scheduled one refresh

    overlay.clear('c1')
    expect(overlay.isBusy('app-1')).toBe(false)
    expect(changes).toEqual(['office-1', 'office-1']) // clear scheduled another
  })

  it('clearForApp drops every in-flight entry for a member (owner offline)', () => {
    const changes: string[] = []
    const overlay = createRemoteBusyOverlay((officeId) => changes.push(officeId))

    overlay.mark('c1', 'office-1', 'app-1', 'node-b')
    overlay.mark('c2', 'office-1', 'app-1', 'node-b')
    changes.length = 0

    overlay.clearForApp('app-1')
    expect(overlay.isBusy('app-1')).toBe(false)
    expect(changes).toHaveLength(2) // one change per dropped entry
  })

  it('TTL eviction fires onChange so a stuck working pulse self-corrects', () => {
    vi.useFakeTimers()
    try {
      const changes: string[] = []
      const overlay = createRemoteBusyOverlay((officeId) => changes.push(officeId))

      overlay.mark('c1', 'office-1', 'app-1', 'node-b')
      changes.length = 0 // ignore the mark notification

      // Before the backstop: still busy, no eviction, no refresh.
      vi.advanceTimersByTime(60_000)
      expect(overlay.isBusy('app-1')).toBe(true)
      expect(changes).toHaveLength(0)

      // Past the 10-minute backstop: the query evicts the stale entry AND
      // schedules a roster refresh, so the lingering 'working' is corrected
      // instead of persisting silently.
      vi.advanceTimersByTime(10 * 60_000)
      expect(overlay.isBusy('app-1')).toBe(false)
      expect(changes).toEqual(['office-1'])
    } finally {
      vi.useRealTimers()
    }
  })
})
