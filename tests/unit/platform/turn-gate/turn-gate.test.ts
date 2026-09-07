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
 * - `isOccupied` reporting a held reservation the caller's busy probe cannot see
 * - the reservation watchdog reclaiming a slot whose turn-end report was lost,
 *   and refusing to reclaim one while a turn is actually streaming
 */

import { describe, it, expect, vi } from 'vitest'
import { createTurnGate } from '../../../../src/main/platform/turn-gate'
import type { TurnGateHooks } from '../../../../src/main/platform/turn-gate'

interface Job {
  body: string
}

interface MakeHooksOptions {
  /**
   * Mark the session busy the moment a dispatch is accepted, i.e. a turn that
   * is really streaming rather than one still in the reservation window. Off by
   * default so the existing tests keep driving `busy` by hand.
   */
  busyOnDispatch?: boolean
  /** Supply `deliverMidTurn`, and what it answers. Absent → hook not offered at all. */
  midTurn?: 'accept' | 'decline' | 'throw'
}

/** A mock hooks implementation that records dispatches and lets the test drive busyness. */
function makeHooks(options: MakeHooksOptions = {}) {
  const dispatched: Array<{ sessionKey: string; job: Job }> = []
  const midTurnDelivered: Array<{ sessionKey: string; job: Job }> = []
  const busy = new Set<string>()
  let midTurnMode = options.midTurn
  const hooks: TurnGateHooks<Job> = {
    dispatch: vi.fn(async (sessionKey: string, job: Job) => {
      dispatched.push({ sessionKey, job })
      if (options.busyOnDispatch) busy.add(sessionKey)
    }),
    isBusy: (sessionKey: string) => busy.has(sessionKey),
    ...(options.midTurn
      ? {
          deliverMidTurn: vi.fn((sessionKey: string, job: Job) => {
            if (midTurnMode === 'throw') throw new Error('session went away')
            midTurnDelivered.push({ sessionKey, job })
            return midTurnMode === 'accept'
          }),
        }
      : {}),
  }
  const setMidTurn = (mode: MakeHooksOptions['midTurn']): void => {
    midTurnMode = mode
  }
  return { hooks, dispatched, midTurnDelivered, busy, setMidTurn }
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
  // Mid-turn delivery: a job may join the turn that is already running instead
  // of waiting behind it. Every guard below exists because handing it over in
  // that state would be wrong, not merely early.
  // ===========================================================================

  describe('deliver — mid-turn delivery', () => {
    it('hands the job to a streaming turn the gate itself dispatched', async () => {
      const { hooks, dispatched, midTurnDelivered } = makeHooks({ busyOnDispatch: true, midTurn: 'accept' })
      const gate = createTurnGate<Job>(hooks)

      await gate.deliver('s1', { body: 'first' })
      const disposition = await gate.deliver('s1', { body: 'second' })

      expect(disposition).toBe('mid_turn')
      // No second turn, and nothing left waiting: it went into the first one.
      expect(dispatched).toHaveLength(1)
      expect(gate.hasBuffered('s1')).toBe(false)
      expect(midTurnDelivered).toEqual([{ sessionKey: 's1', job: { body: 'second' } }])
    })

    it('buffers instead when the running turn is not one the gate dispatched', async () => {
      // Busy without a reservation = a turn started outside this gate (its
      // owner typing into the same conversation). Someone else's message must
      // not be folded into that.
      const { hooks, midTurnDelivered, busy } = makeHooks({ midTurn: 'accept' })
      busy.add('s1')
      const gate = createTurnGate<Job>(hooks)

      expect(await gate.deliver('s1', { body: 'x' })).toBe('buffered')
      expect(midTurnDelivered).toHaveLength(0)
    })

    it('buffers instead while the dispatch is still in flight (nothing to join yet)', async () => {
      // Reserved but not streaming: the reservation window. There is no live
      // turn to hand anything to.
      const { hooks, midTurnDelivered } = makeHooks({ midTurn: 'accept' })
      const gate = createTurnGate<Job>(hooks)

      await gate.deliver('s1', { body: 'first' })
      expect(await gate.deliver('s1', { body: 'second' })).toBe('buffered')
      expect(midTurnDelivered).toHaveLength(0)
    })

    it('buffers instead when the mailbox is not empty, so nothing overtakes it', async () => {
      // Order is the whole value of a later message: it may supersede an
      // earlier one, which only works if it is read after it.
      const { hooks, midTurnDelivered, setMidTurn } = makeHooks({ busyOnDispatch: true, midTurn: 'decline' })
      const gate = createTurnGate<Job>(hooks)

      await gate.deliver('s1', { body: 'first' })
      expect(await gate.deliver('s1', { body: 'queued' })).toBe('buffered')

      setMidTurn('accept')
      expect(await gate.deliver('s1', { body: 'later' })).toBe('buffered')
      // The hook was not even consulted for it — the queue in front is enough.
      expect(midTurnDelivered.map((d) => d.job.body)).not.toContain('later')
    })

    it('falls back to the mailbox when the hook declines', async () => {
      const { hooks, midTurnDelivered } = makeHooks({ busyOnDispatch: true, midTurn: 'decline' })
      const gate = createTurnGate<Job>(hooks)

      await gate.deliver('s1', { body: 'first' })

      expect(await gate.deliver('s1', { body: 'second' })).toBe('buffered')
      expect(midTurnDelivered).toHaveLength(1) // it was attempted
      expect(gate.hasBuffered('s1')).toBe(true)
    })

    it('falls back to the mailbox when the hook throws', async () => {
      const { hooks } = makeHooks({ busyOnDispatch: true, midTurn: 'throw' })
      const gate = createTurnGate<Job>(hooks)

      await gate.deliver('s1', { body: 'first' })

      expect(await gate.deliver('s1', { body: 'second' })).toBe('buffered')
      expect(gate.hasBuffered('s1')).toBe(true)
    })

    it('leaves onBusy=skip alone — a wake with its own rhythm is still dropped', async () => {
      const { hooks, midTurnDelivered } = makeHooks({ busyOnDispatch: true, midTurn: 'accept' })
      const gate = createTurnGate<Job>(hooks)

      await gate.deliver('s1', { body: 'first' })

      expect(await gate.deliver('s1', { body: 'recurring' }, 'skip')).toBe('skipped')
      expect(midTurnDelivered).toHaveLength(0)
      expect(gate.hasBuffered('s1')).toBe(false)
    })

    it('buffers as before for a caller that offers no mid-turn hook', async () => {
      const { hooks } = makeHooks({ busyOnDispatch: true })
      const gate = createTurnGate<Job>(hooks)

      await gate.deliver('s1', { body: 'first' })

      expect(await gate.deliver('s1', { body: 'second' })).toBe('buffered')
      expect(gate.hasBuffered('s1')).toBe(true)
    })

    it('discard does not free a slot whose turn is still streaming', async () => {
      // `discard` is a hard reset of what has NOT started — the mail and its
      // timers. Freeing a streaming turn's slot instead lets the next delivery
      // start a second turn on a session that is still producing, which is the
      // one thing this lock exists to prevent. It matters at a seal, where the
      // reset now runs before sessions are torn down.
      const { hooks, dispatched } = makeHooks({ busyOnDispatch: true })
      const gate = createTurnGate<Job>(hooks)

      await gate.deliver('s1', { body: 'streaming' })
      gate.discard((key) => key === 's1', 'the run was stopped')

      expect(gate.isOccupied('s1')).toBe(true)
      // And the slot is genuinely held, not merely reported: a new delivery
      // cannot start a second turn on it.
      expect(await gate.deliver('s1', { body: 'second' })).toBe('buffered')
      expect(dispatched).toHaveLength(1)
    })

    it('discard still frees a slot reserved for a turn that never started', async () => {
      // The stranded-reservation case discard is for: dispatch accepted, nothing
      // streaming. Keeping it would leave the session locked with no turn to
      // ever release it.
      const { hooks } = makeHooks()
      const gate = createTurnGate<Job>(hooks)

      await gate.deliver('s1', { body: 'never streamed' })
      expect(gate.isOccupied('s1')).toBe(true)

      gate.discard((key) => key === 's1', 'the run was stopped')
      expect(gate.isOccupied('s1')).toBe(false)
    })

    it('delivers a job mid-turn without freeing the slot the running turn holds', async () => {
      const { hooks, dispatched } = makeHooks({ busyOnDispatch: true, midTurn: 'accept' })
      const gate = createTurnGate<Job>(hooks)

      await gate.deliver('s1', { body: 'first' })
      await gate.deliver('s1', { body: 'second' })

      expect(gate.isOccupied('s1')).toBe(true)
      // And the turn that was running is still the only one.
      expect(dispatched).toHaveLength(1)
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

        // Drained mailbox → no recheck left. The drained job now holds the slot,
        // so its reservation watchdog is the one timer still armed; releasing the
        // slot (what a turn ending does) leaves nothing running.
        gate.release('s1')
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

  // ===========================================================================
  // isOccupied — the gate's own answer, not the caller's busy probe
  // ===========================================================================

  describe('isOccupied', () => {
    it('is true for a held reservation the caller busy-probe cannot see', async () => {
      const { hooks } = makeHooks()
      const gate = createTurnGate<Job>(hooks)

      expect(gate.isOccupied('s1')).toBe(false)
      await gate.deliver('s1', { body: 'running' })
      // `busy` was never set: the caller's session layer has not registered the
      // turn yet. The gate must still report the session as taken, or a status
      // surface reading the probe shows idle while mail is queueing.
      expect(hooks.isBusy('s1')).toBe(false)
      expect(gate.isOccupied('s1')).toBe(true)

      gate.release('s1')
      expect(gate.isOccupied('s1')).toBe(false)
    })

    it('is true for a running turn with no reservation', () => {
      const { hooks, busy } = makeHooks()
      const gate = createTurnGate<Job>(hooks)
      busy.add('s1')
      expect(gate.isOccupied('s1')).toBe(true)
    })
  })

  // ===========================================================================
  // Reservation watchdog — a lost turn-end report must not lock the session
  // ===========================================================================

  describe('reservation watchdog', () => {
    it('reclaims a reservation whose turn never reported an ending, and drains the mail', async () => {
      vi.useFakeTimers()
      try {
        const { hooks, dispatched } = makeHooks()
        const gate = createTurnGate<Job>(hooks, { reservationTtlMs: 10_000, recheckMs: 60_000 })

        // Dispatched, then the caller loses the completion: no release ever comes.
        await gate.deliver('s1', { body: 'first' })
        expect(dispatched).toHaveLength(1)

        // Everything after it can only queue, and the session reads occupied.
        expect(await gate.deliver('s1', { body: 'stranded' })).toBe('buffered')
        expect(gate.isOccupied('s1')).toBe(true)

        await vi.advanceTimersByTimeAsync(11_000)

        expect(gate.hasBuffered('s1')).toBe(false)
        expect(dispatched.map((d) => d.job.body)).toEqual(['first', 'stranded'])
      } finally {
        vi.useRealTimers()
      }
    })

    it('never reclaims a slot while a turn is actually streaming', async () => {
      vi.useFakeTimers()
      try {
        const { hooks, dispatched, busy } = makeHooks()
        const gate = createTurnGate<Job>(hooks, { reservationTtlMs: 10_000, recheckMs: 60_000 })

        await gate.deliver('s1', { body: 'long-turn' })
        busy.add('s1') // the session layer registered the turn
        await gate.deliver('s1', { body: 'behind-it' })

        // Far past the TTL: freeing the slot here would start a second turn on a
        // session the first is still streaming on.
        await vi.advanceTimersByTimeAsync(100_000)
        expect(dispatched).toHaveLength(1)
        expect(gate.hasBuffered('s1')).toBe(true)

        // The turn ends and the caller reports it — normal path, mail flows.
        busy.delete('s1')
        gate.release('s1')
        gate.drain('s1')
        await vi.advanceTimersByTimeAsync(0)
        expect(dispatched.map((d) => d.job.body)).toEqual(['long-turn', 'behind-it'])
      } finally {
        vi.useRealTimers()
      }
    })

    it('is not armed at all unless the caller asked for it', async () => {
      // A caller with its own (stricter) phantom test recovers its slots better
      // than this can — arming a blinder reclaimer beside it would free
      // reservations it deliberately holds. Opt-in, no default.
      vi.useFakeTimers()
      try {
        const { hooks, dispatched } = makeHooks()
        const gate = createTurnGate<Job>(hooks)

        await gate.deliver('s1', { body: 'held-forever' })
        expect(await gate.deliver('s1', { body: 'behind-it' })).toBe('buffered')

        await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000)
        expect(dispatched).toHaveLength(1)
        expect(gate.isOccupied('s1')).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it('a released slot leaves no watchdog behind', async () => {
      vi.useFakeTimers()
      try {
        const { hooks } = makeHooks()
        const gate = createTurnGate<Job>(hooks, { reservationTtlMs: 10_000 })

        await gate.deliver('s1', { body: 'one' })
        gate.release('s1')

        await vi.advanceTimersByTimeAsync(20_000)
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
