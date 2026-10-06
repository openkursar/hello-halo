/**
 * Streamed deltas are published at most once per interval, merged per target
 * and in arrival order, whatever the token rate of the provider.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { emitAgentEvent } = vi.hoisted(() => ({ emitAgentEvent: vi.fn() }))
vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent }))

import { createDeltaCoalescer, DELTA_INTERVAL_MS } from '../../../../src/main/services/agent/delta-coalescer'

const published = () => emitAgentEvent.mock.calls.map(([channel, , , data]) => ({ channel, ...data }))

beforeEach(() => {
  vi.useFakeTimers()
  emitAgentEvent.mockClear()
})
afterEach(() => { vi.useRealTimers() })

describe('delta coalescer', () => {
  it('merges consecutive deltas of one target and publishes them once the interval passes', () => {
    const deltas = createDeltaCoalescer('space-1', 'conv-1')
    deltas.text('Hel')
    deltas.text('lo')
    expect(emitAgentEvent).not.toHaveBeenCalled()
    vi.advanceTimersByTime(DELTA_INTERVAL_MS)
    expect(emitAgentEvent).toHaveBeenCalledTimes(1)
    expect(emitAgentEvent).toHaveBeenCalledWith('agent:message', 'space-1', 'conv-1', {
      type: 'message', delta: 'Hello', isComplete: false, isStreaming: true,
    })
  })

  it('keeps arrival order across targets and never merges across another target', () => {
    const deltas = createDeltaCoalescer('space-1', 'conv-1')
    deltas.thought('t1', 'think ')
    deltas.thought('t1', 'more')
    deltas.thought('t2', 'other')
    deltas.text('Answer')
    deltas.thought('t1', ' again')
    deltas.flush()
    expect(published()).toEqual([
      { channel: 'agent:thought-delta', thoughtId: 't1', delta: 'think more' },
      { channel: 'agent:thought-delta', thoughtId: 't2', delta: 'other' },
      { channel: 'agent:message', type: 'message', delta: 'Answer', isComplete: false, isStreaming: true },
      { channel: 'agent:thought-delta', thoughtId: 't1', delta: ' again' },
    ])
  })

  it('publishes at most once per interval however fast deltas arrive', () => {
    const deltas = createDeltaCoalescer('space-1', 'conv-1')
    let sent = ''
    // 200 deltas a second for one second.
    for (let i = 0; i < 200; i++) {
      deltas.text(`${i},`)
      sent += `${i},`
      vi.advanceTimersByTime(5)
    }
    deltas.flush()
    const calls = emitAgentEvent.mock.calls
    expect(calls.length).toBeLessThanOrEqual(Math.ceil(1000 / DELTA_INTERVAL_MS) + 1)
    expect(calls.map(([, , , data]) => data.delta).join('')).toBe(sent)
  })

  it('flush publishes at once and cancels the pending interval; empty deltas are not published', () => {
    const deltas = createDeltaCoalescer('space-1', 'conv-1')
    deltas.text('')
    deltas.flush()
    expect(emitAgentEvent).not.toHaveBeenCalled()
    deltas.text('now')
    deltas.flush()
    expect(emitAgentEvent).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(DELTA_INTERVAL_MS * 3)
    expect(emitAgentEvent).toHaveBeenCalledTimes(1)
  })

  it('discard drops what is pending and publishes nothing later', () => {
    const deltas = createDeltaCoalescer('space-1', 'conv-1')
    deltas.text('late')
    deltas.thought('t1', 'late')
    deltas.discard()
    vi.advanceTimersByTime(DELTA_INTERVAL_MS * 3)
    deltas.flush()
    expect(emitAgentEvent).not.toHaveBeenCalled()
  })
})
