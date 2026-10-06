/**
 * A turn's streamed deltas reach clients merged, at most about once per frame
 * interval, and never behind an event produced after them: block starts and
 * stops, tool calls, completion and errors go out after the deltas before
 * them. A stop publishes what streamed before it at once; a retired session
 * publishes nothing more.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { emitAgentEvent } = vi.hoisted(() => ({ emitAgentEvent: vi.fn() }))

vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent }))
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn().mockResolvedValue(undefined) },
}))
vi.mock('../../../../src/main/services/agent/mcp-manager', () => ({ broadcastMcpStatus: vi.fn() }))
vi.mock('../../../../src/main/services/agent/mcp-probe', () => ({ probeUnhealthyServers: vi.fn() }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../../../../src/main/foundation/logging', () => ({ isDeveloperMode: () => false }))

import { processStream } from '../../../../src/main/services/agent/stream-processor'
import { DELTA_INTERVAL_MS } from '../../../../src/main/services/agent/delta-coalescer'
import type { SessionState } from '../../../../src/main/services/agent/types'

type Frame = Record<string, unknown> | { wait: number } | { abort: true }

const init = { type: 'system', subtype: 'init', session_id: 's', tools: [], mcp_servers: [] }
const result = { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's' }
const streamEvent = (event: Record<string, unknown>) => ({ type: 'stream_event', event, parent_tool_use_id: null, session_id: 's' })
const textStart = (index: number) => streamEvent({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
const textDelta = (index: number, text: string) => streamEvent({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
const thinkingStart = (index: number) => streamEvent({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } })
const thinkingDelta = (index: number, thinking: string) => streamEvent({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } })
const blockStop = (index: number) => streamEvent({ type: 'content_block_stop', index })

function newState(abortController = new AbortController()): SessionState {
  return { spaceId: 'space-1', conversationId: 'conv-1', thoughts: [], abortController } as unknown as SessionState
}

/** Runs frames through processStream; `{ wait }` pauses the stream, `{ abort }` stops the turn. */
function run(frames: Frame[], options: { abortController?: AbortController; sessionSignal?: AbortSignal } = {}) {
  const abortController = options.abortController ?? new AbortController()
  return processStream({
    v2Session: {
      send: vi.fn(),
      stream: () => (async function* () {
        for (const frame of frames) {
          if ('wait' in frame) await new Promise(resolve => setTimeout(resolve, frame.wait as number))
          else if ('abort' in frame) abortController.abort()
          else yield frame
        }
      })(),
    },
    sessionState: newState(abortController),
    spaceId: 'space-1',
    conversationId: 'conv-1',
    messageContent: 'Hi',
    displayModel: 'm',
    abortController,
    sessionSignal: options.sessionSignal,
    t0: Date.now(),
    callbacks: {},
  } as unknown as Parameters<typeof processStream>[0])
}

const events = () => emitAgentEvent.mock.calls.map(([channel, , , data]) => ({ channel: channel as string, data: data as Record<string, any> }))
const isTextDelta = (e: { channel: string; data: Record<string, any> }) => e.channel === 'agent:message' && typeof e.data.delta === 'string'

beforeEach(() => {
  vi.useFakeTimers()
  emitAgentEvent.mockClear()
})
afterEach(() => { vi.useRealTimers() })

describe('streamed deltas', () => {
  it('go out merged and ahead of the events produced after them', async () => {
    const outcome = run([
      init,
      streamEvent({ type: 'message_start', message: { id: 'm1' } }),
      thinkingStart(0), thinkingDelta(0, 'Let '), thinkingDelta(0, 'me '), thinkingDelta(0, 'think'), blockStop(0),
      textStart(1), textDelta(1, 'Hello '), textDelta(1, 'there'), blockStop(1),
      streamEvent({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu1', name: 'Bash' } }),
      streamEvent({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"command":' } }),
      streamEvent({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"ls"}' } }),
      blockStop(2),
      result,
    ])
    await vi.runAllTimersAsync()
    await outcome

    const sequence = events().map(({ channel, data }) =>
      channel === 'agent:thought-delta'
        ? `thought-delta:${data.isComplete ? 'complete' : data.delta}`
        : channel === 'agent:message'
          ? `message:${data.isNewTextBlock ? 'start' : data.delta ?? (data.isComplete ? 'final' : 'block')}`
          : channel === 'agent:thought' ? `thought:${data.thought.type}` : channel)
    expect(sequence).toEqual([
      'thought:system',
      'thought:thinking', 'thought-delta:Let me think', 'thought-delta:complete',
      'message:start', 'message:Hello there', 'message:block',
      'thought:tool_use', 'thought-delta:{"command":"ls"}', 'thought-delta:complete', 'agent:tool-call',
      'thought:result', 'message:final', 'agent:complete',
    ])
  })

  it('reach clients at most about once per interval at 200 deltas a second, with nothing lost', async () => {
    const pieces = Array.from({ length: 200 }, (_, i) => `w${i} `)
    const outcome = run([
      init, textStart(0),
      ...pieces.flatMap(piece => [textDelta(0, piece), { wait: 5 }]),
      blockStop(0), result,
    ])
    await vi.runAllTimersAsync()
    const { finalContent } = await outcome

    const deltas = events().filter(isTextDelta)
    expect(deltas.length).toBeLessThanOrEqual(Math.ceil(1000 / DELTA_INTERVAL_MS) + 1)
    expect(deltas.map(e => e.data.delta).join('')).toBe(pieces.join(''))
    expect(finalContent).toBe(pieces.join(''))
  })

  it('pending while the model pauses are published when the interval ends, not when it resumes', async () => {
    const outcome = run([init, textStart(0), textDelta(0, 'Before the pause'), { wait: 10_000 }, blockStop(0), result])
    await vi.advanceTimersByTimeAsync(DELTA_INTERVAL_MS)
    expect(events().filter(isTextDelta).map(e => e.data.delta)).toEqual(['Before the pause'])
    await vi.runAllTimersAsync()
    await outcome
  })

  it('pending at a stop are published at once, before the turn drains', async () => {
    const abortController = new AbortController()
    const outcome = run([init, textStart(0), textDelta(0, 'Up to the stop'), { abort: true }, textDelta(0, 'drained'), result], { abortController })
    await vi.runAllTimersAsync()
    const streamResult = await outcome

    expect(events().filter(isTextDelta).map(e => e.data.delta)).toEqual(['Up to the stop'])
    expect(JSON.stringify(emitAgentEvent.mock.calls)).not.toContain('drained')
    expect(streamResult).toMatchObject({ wasAborted: true, finalContent: 'Up to the stop' })
  })

  it('pending when the session retires are never published', async () => {
    const retire = new AbortController()
    const outcome = run([init, textStart(0), textDelta(0, 'Never shown'), { wait: 1 }, { wait: 0 }], { sessionSignal: retire.signal })
    const settled = outcome.then(() => null, (error: Error) => error)
    await vi.advanceTimersByTimeAsync(1)
    retire.abort()
    await vi.runAllTimersAsync()
    expect(await settled).toMatchObject({ name: 'AbortError' })
    expect(events().filter(isTextDelta)).toEqual([])
  })
})
