/**
 * Unit tests for platform/turn-gate — the generic "one turn per session key"
 * lock and its FIFO mailbox, extracted from the team message bus so ordinary
 * conversations (Cross-Conversation Interop) can share the exact same
 * exclusivity mechanics instead of forking them.
 *
 * Covers:
 * - the async reservation window between `dispatch` accepting a job and the
 *   caller's own `isBusy` turning true (two deliveries racing that window
 *   must not start two turns on one session key)
 * - mailbox overflow sheds the OLDEST entry, cancelling a shed relayed run
 * - `drain` on a still-busy session re-arms the recheck instead of dropping it
 * - `discard` rejects a queued relayed run's caller instead of leaving it hanging
 * - `deliver` dispositions (dispatched / buffered / skipped), `release`+`drain`
 *   composition, and `hasBuffered` / `hasAnyBuffered`
 */

import { describe, it, expect, vi } from 'vitest'
import { createTurnGate } from '../../../../src/main/platform/turn-gate'
import type { TurnGateHooks } from '../../../../src/main/platform/turn-gate'

interface Job {
  body: string
}

/** A mock hooks implementation that records dispatches and lets the test drive busyness. */
function makeHooks() {
  const dispatched: Array<{ sessionKey: string; job: Job }> = []
  const busy = new Set<string>()
  const hooks: TurnGateHooks<Job> = {
    dispatch: vi.fn(async (sessionKey: string, job: Job) => {
      dispatched.push({ sessionKey, job })
    }),
    isBusy: (sessionKey: string) => busy.has(sessionKey),
  }
  return { hooks, dispatched, busy }
}

describe('createTurnGate', () => {
  describe('deliver — dispositions', () => {
    it('dispatches immediately on an idle session', async () => {
      const { hooks, dispatched } = makeHooks()
      const gate = createTurnGate<Job>(hooks)

      const disposition = await gate.deliver('s1', { body: 'hello' })

      expect(disposition).toBe('dispatched')
      expect(dispatched).toEqual([{ sessionKey: 's1', job: { body: 'hello' } }])
    })

    it('buffers when the session is busy (onBusy default = buffer)', async () => {
      const { hooks, dispatched, busy } = makeHooks()
      busy.add('s1')
      const gate = createTurnGate<Job>(hooks)

      const disposition = await gate.deliver('s1', { body: 'queued' })

      expect(disposition).toBe('buffered')
      expect(dispatched).toHaveLength(0)
      expect(gate.hasBuffered('s1')).toBe(true)
    })

    it('drops the job when busy and onBusy=skip', async () => {
      const { hooks, dispatched, busy } = makeHooks()
      busy.add('s1')
      const gate = createTurnGate<Job>(hooks)

      const disposition = await gate.deliver('s1', { body: 'skip-me' }, 'skip')

      expect(disposition).toBe('skipped')
      expect(dispatched).toHaveLength(0)
      expect(gate.hasBuffered('s1')).toBe(false)
    })

    it('releases the reservation when dispatch throws (no fake-busy deadlock)', async () => {
      const { hooks, dispatched } = makeHooks()
      ;(hooks.dispatch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('spawn failed'))
      const gate = createTurnGate<Job>(hooks)

      await expect(gate.deliver('s1', { body: 'lost' })).rejects.toThrow('spawn failed')

      // The key must not stay reserved: the next delivery dispatches normally.
      const disposition = await gate.deliver('s1', { body: 'retry' })
      expect(disposition).toBe('dispatched')
      expect(dispatched).toEqual([{ sessionKey: 's1', job: { body: 'retry' } }])
    })
  })

  // ===========================================================================
  // The reservation window: dispatch() resolving (accepted) does not mean the
  // caller's own isBusy() has registered the turn yet. Two deliveries racing
  // that async gap must still produce exactly one dispatched turn.
  // ===========================================================================

  describe('reservation window (dispatch-accepted but isBusy still false)', () => {
    it('a second delivery inside the window buffers instead of starting a second turn', async () => {
      const { hooks, dispatched } = makeHooks()
      // isBusy never turns true in this test — the exact race window, held open.
      const gate = createTurnGate<Job>(hooks)

      const first = gate.deliver('s1', { body: 'first' })
      const second = gate.deliver('s1', { body: 'second' })

      const [firstDisposition, secondDisposition] = await Promise.all([first, second])

      // Only one turn was ever dispatched; the second queued behind the
      // reservation the first delivery took synchronously.
      expect(firstDisposition).toBe('dispatched')
      expect(secondDisposition).toBe('buffered')
      expect(dispatched).toHaveLength(1)
      expect(dispatched[0].job.body).toBe('first')
      expect(gate.hasBuffered('s1')).toBe(true)
    })

    it('the buffered entry drains once the reservation is released', async () => {
      const { hooks, dispatched } = makeHooks()
      const gate = createTurnGate<Job>(hooks)

      await gate.deliver('s1', { body: 'first' })
      await gate.deliver('s1', { body: 'second' })
      expect(dispatched).toHaveLength(1)

      gate.release('s1')
      gate.drain('s1')
      // drain's dispatch is fire-and-forget internally; flush microtasks.
      await Promise.resolve()
      await Promise.resolve()

      expect(dispatched).toHaveLength(2)
      expect(dispatched[1].job.body).toBe('second')
    })
  })

  // ===========================================================================
  // Mailbox overflow
  // ===========================================================================

  describe('mailbox overflow', () => {
    it('caps the per-session mailbox, shedding the OLDEST entry', async () => {
      const { hooks, dispatched, busy } = makeHooks()
      busy.add('s1') // stays busy the whole time, nothing drains
      const gate = createTurnGate<Job>(hooks, { bufferCap: 3 })

      for (let i = 0; i < 5; i++) {
        await gate.deliver('s1', { body: `msg-${i}` })
      }
      expect(dispatched).toHaveLength(0)

      // Drain one: the oldest SURVIVOR is msg-2 (msg-0 and msg-1 were shed).
      busy.delete('s1')
      gate.drain('s1')
      await Promise.resolve()
      expect(dispatched[0].job.body).toBe('msg-2')
    })

    it('cancels a shed RELAYED run instead of stranding its caller', async () => {
      const { hooks, busy } = makeHooks()
      busy.add('s1')
      const gate = createTurnGate<Job>(hooks, { bufferCap: 1 })

      // First relayed run occupies the mailbox's one slot.
      const shed = gate.runExclusive('s1', async () => 'should never run')
      const shedRejection = expect(shed).rejects.toThrow(/mailbox overflow/)

      // A second entry overflows the cap-1 mailbox and sheds the first.
      await gate.deliver('s1', { body: 'evicts the relayed run' })

      await shedRejection
    })
  })

  // ===========================================================================
  // drain() re-arming the recheck backstop while still busy
  // ===========================================================================

  describe('drain on a busy session', () => {
    it('re-arms the recheck instead of dropping the buffered entry', async () => {
      vi.useFakeTimers()
      try {
        const { hooks, dispatched, busy } = makeHooks()
        busy.add('s1')
        const gate = createTurnGate<Job>(hooks, { recheckMs: 1000 })

        await gate.deliver('s1', { body: 'held' })
        expect(dispatched).toHaveLength(0)

        // Explicit drain while still busy must not discard the mail — it
        // re-arms its own backstop.
        gate.drain('s1')
        await vi.advanceTimersByTimeAsync(1500) // one recheck fires, still busy → re-arms
        expect(dispatched).toHaveLength(0)
        expect(gate.hasBuffered('s1')).toBe(true)

        busy.delete('s1')
        await vi.advanceTimersByTimeAsync(1000) // the re-armed recheck fires
        expect(dispatched).toHaveLength(1)
        expect(dispatched[0].job.body).toBe('held')
      } finally {
        vi.useRealTimers()
      }
    })

    it('the recheck keeps re-arming for as long as the target stays busy', async () => {
      vi.useFakeTimers()
      try {
        const { hooks, dispatched, busy } = makeHooks()
        busy.add('s1')
        const gate = createTurnGate<Job>(hooks, { recheckMs: 1000 })

        await gate.deliver('s1', { body: 'held' })
        await vi.advanceTimersByTimeAsync(5000) // several rechecks, all still busy
        expect(dispatched).toHaveLength(0)

        busy.delete('s1')
        await vi.advanceTimersByTimeAsync(1000)
        expect(dispatched).toHaveLength(1)

        // Drained mailbox → no timer left running.
        await vi.advanceTimersByTimeAsync(5000)
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // ===========================================================================
  // discard() — hard reset must not strand a relayed caller
  // ===========================================================================

  describe('discard', () => {
    it('rejects a queued relayed run instead of leaving its caller hanging', async () => {
      const { hooks, busy } = makeHooks()
      busy.add('s1')
      const gate = createTurnGate<Job>(hooks)

      const relayed = gate.runExclusive('s1', async () => 'ran')
      const rejection = expect(relayed).rejects.toThrow(/run was stopped/)

      const dropped = gate.discard((key) => key === 's1', 'the run was stopped')

      await rejection
      // The relayed run is not counted as a dropped JOB.
      expect(dropped).toBe(0)
    })

    it('counts and drops buffered JOBS, and only sessions matching the predicate', async () => {
      const { hooks, dispatched, busy } = makeHooks()
      busy.add('s1')
      busy.add('s2')
      const gate = createTurnGate<Job>(hooks)

      await gate.deliver('s1', { body: 'a' })
      await gate.deliver('s1', { body: 'b' })
      await gate.deliver('s2', { body: 'c' })

      const dropped = gate.discard((key) => key === 's1', 'reset')

      expect(dropped).toBe(2)
      expect(gate.hasBuffered('s1')).toBe(false)
      expect(gate.hasAnyBuffered((key) => key === 's2')).toBe(true)

      // s1's reservation was released too — a fresh delivery dispatches, not queues.
      busy.delete('s1')
      const disposition = await gate.deliver('s1', { body: 'fresh' })
      expect(disposition).toBe('dispatched')
      expect(dispatched.find((d) => d.job.body === 'fresh')).toBeTruthy()
    })

    it('clears a pending recheck timer for a discarded session', async () => {
      vi.useFakeTimers()
      try {
        const { hooks, busy } = makeHooks()
        busy.add('s1')
        const gate = createTurnGate<Job>(hooks, { recheckMs: 1000 })

        await gate.deliver('s1', { body: 'x' })
        gate.discard((key) => key === 's1', 'reset')

        // No leftover timer to fire.
        await vi.advanceTimersByTimeAsync(5000)
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // ===========================================================================
  // runExclusive — the relayed-turn gate
  // ===========================================================================

  describe('runExclusive', () => {
    it('runs immediately on an idle session', async () => {
      const { hooks } = makeHooks()
      const gate = createTurnGate<Job>(hooks)

      const out = await gate.runExclusive('s1', async () => 'ran')
      expect(out).toBe('ran')
    })

    it('queues behind a busy session and runs once released', async () => {
      const { hooks, busy } = makeHooks()
      busy.add('s1')
      const gate = createTurnGate<Job>(hooks)

      let started = false
      const relayed = gate.runExclusive('s1', async () => {
        started = true
        return 'ran'
      })
      await Promise.resolve()
      expect(started).toBe(false)

      busy.delete('s1')
      gate.drain('s1')
      await expect(relayed).resolves.toBe('ran')
      expect(started).toBe(true)
    })

    it('serialises several relayed runs rather than overlapping them', async () => {
      const { hooks } = makeHooks()
      const gate = createTurnGate<Job>(hooks)

      const order: string[] = []
      let resolveFirst!: () => void
      const first = new Promise<void>((r) => (resolveFirst = r))

      const a = gate.runExclusive('s1', async () => {
        order.push('a:start')
        await first
        order.push('a:end')
      })
      const b = gate.runExclusive('s1', async () => {
        order.push('b:start')
      })

      await Promise.resolve()
      expect(order).toEqual(['a:start'])

      resolveFirst()
      await a
      await Promise.resolve()
      expect(order).toEqual(['a:start', 'a:end', 'b:start'])
      await b
    })

    it('releases the slot when the run throws', async () => {
      const { hooks } = makeHooks()
      const gate = createTurnGate<Job>(hooks)

      await expect(
        gate.runExclusive('s1', async () => {
          throw new Error('boom')
        })
      ).rejects.toThrow('boom')

      const disposition = await gate.deliver('s1', { body: 'after-throw' })
      expect(disposition).toBe('dispatched')
    })

    it('holds the slot while running, so a local delivery queues behind it', async () => {
      const { hooks, dispatched } = makeHooks()
      const gate = createTurnGate<Job>(hooks)

      let resolveGate!: (v: string) => void
      const gatePromise = new Promise<string>((r) => (resolveGate = r))
      const relayed = gate.runExclusive('s1', () => gatePromise)
      await Promise.resolve()

      const disposition = await gate.deliver('s1', { body: 'queued-behind-relay' })
      expect(disposition).toBe('buffered')
      expect(dispatched).toHaveLength(0)

      resolveGate('done')
      await relayed
      await Promise.resolve()
      expect(dispatched).toHaveLength(1)
      expect(dispatched[0].job.body).toBe('queued-behind-relay')
    })
  })

  describe('hasBuffered / hasAnyBuffered', () => {
    it('reports false for an untouched session', () => {
      const { hooks } = makeHooks()
      const gate = createTurnGate<Job>(hooks)
      expect(gate.hasBuffered('s1')).toBe(false)
      expect(gate.hasAnyBuffered(() => true)).toBe(false)
    })
  })
})
