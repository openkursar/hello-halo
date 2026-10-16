/**
 * The consumer hands raw engine messages to the session manager and retires
 * cleanly when a sink callback stops it mid-turn.
 */

import { beforeEach, describe, it, expect, vi } from 'vitest'
import type { ProcessStreamParams, StreamResult } from '../../../../src/main/services/agent/stream-processor'
import type { SessionState, V2SDKSession } from '../../../../src/main/services/agent/types'
import type { TurnSink } from '../../../../src/main/services/agent/turn-sink'
import { processStream } from '../../../../src/main/services/agent/stream-processor'
import { createSessionState, consumePendingRebuild, noteSessionMcpStatus } from '../../../../src/main/services/agent/session-manager'
import { emitAgentEvent } from '../../../../src/main/services/agent/events'

vi.mock('../../../../src/main/services/agent/stream-processor', () => ({ processStream: vi.fn() }))
vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent: vi.fn() }))
vi.mock('../../../../src/main/services/agent/session-manager', () => ({
  createSessionState: vi.fn(),
  consumePendingRebuild: vi.fn(() => false),
  markTurnInitReceived: vi.fn(),
  failPendingSessionTurns: vi.fn(() => false),
  noteSessionMcpStatus: vi.fn(),
}))

const { startConsumer } = await import('../../../../src/main/services/agent/session-consumer')

describe('consumer retirement during sink callbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(createSessionState).mockImplementation((spaceId, conversationId, abortController) => ({
      spaceId, conversationId, abortController, thoughts: [],
    } as SessionState))
    vi.mocked(consumePendingRebuild).mockReturnValue(false)
  })

  it('hands every raw message to the session manager with the session it came from', async () => {
    let params!: ProcessStreamParams
    let resolve!: (result: StreamResult) => void
    vi.mocked(processStream).mockImplementation(input => {
      params = input
      return new Promise<StreamResult>(done => { resolve = done })
    })
    const sink = { onTurnComplete: vi.fn(), onRawMessage: vi.fn() } satisfies TurnSink
    const session = { send: vi.fn(), stream: async function* () {}, close: vi.fn() } satisfies V2SDKSession
    const consumer = startConsumer(session, { spaceId: 'space', conversationId: 'conv', displayModel: 'model', sink })
    await vi.waitFor(() => expect(params).toBeDefined())
    const init = { type: 'system', subtype: 'init', mcp_servers: [{ name: 'local', status: 'failed' }] }

    params.callbacks.onRawMessage!(init)

    expect(noteSessionMcpStatus).toHaveBeenCalledWith('conv', session, init)
    expect(sink.onRawMessage).toHaveBeenCalledWith(init)
    consumer.stop()
    resolve({} as StreamResult)
  })

  it('retires an idle consumer without inventing a completed turn', async () => {
    let resolve!: (result: StreamResult) => void
    vi.mocked(processStream).mockImplementation(() => new Promise<StreamResult>(done => { resolve = done }))
    const sink = { onTurnComplete: vi.fn(), onConsumerStopped: vi.fn() } satisfies TurnSink
    const session = { send: vi.fn(), stream: async function* () {}, close: vi.fn() } satisfies V2SDKSession
    const consumer = startConsumer(session, { spaceId: 'space', conversationId: 'conv', displayModel: 'model', sink })
    consumer.stop()
    consumer.stop()
    expect(sink.onConsumerStopped).toHaveBeenCalledTimes(1)
    expect(emitAgentEvent).not.toHaveBeenCalled()
    resolve({} as StreamResult)
    await vi.waitFor(() => expect(consumer.isRunning).toBe(false))
    expect(sink.onConsumerStopped).toHaveBeenCalledTimes(1)
    expect(sink.onTurnComplete).not.toHaveBeenCalled()
    expect(emitAgentEvent).not.toHaveBeenCalled()
  })

  it.each(['onTurnStart', 'onTurnComplete', 'onTurnError'] as const)('stops publishing when %s retires it and emits one completion', async hook => {
    let params!: ProcessStreamParams
    let resolve!: (result: StreamResult) => void
    let reject!: (error: Error) => void
    const pending = new Promise<StreamResult>((res, rej) => { resolve = res; reject = rej })
    vi.mocked(processStream).mockImplementation(input => { params = input; return pending })
    const sink = {
      onTurnStart: vi.fn(), onTurnComplete: vi.fn(), onTurnError: vi.fn(), onConsumerStopped: vi.fn(),
    } satisfies TurnSink
    const session = { send: vi.fn(), stream: async function* () {}, close: vi.fn() } satisfies V2SDKSession
    const consumer = startConsumer(session, { spaceId: 'space', conversationId: 'conv', displayModel: 'model', sink })
    sink[hook].mockImplementation(() => consumer.stop())
    const partial = { finalContent: 'Received partial', thoughts: [] } as unknown as StreamResult
    const readSnapshot = vi.fn(() => partial)
    params.callbacks.onSnapshotReady!(readSnapshot)
    try {
      params.callbacks.onTurnInit!()
      if (hook === 'onTurnError') reject(new Error('Fixture turn failure'))
      else resolve({
        finalContent: 'Fixture reply', thoughts: [], hasMeaningfulContent: true,
        tokenUsage: null, isInterrupted: false, wasAborted: false,
        hasErrorThought: false, reachedMaxTurns: false, firstEventReceived: true, drainTimedOut: false,
      })
      await vi.waitFor(() => expect(consumer.isRunning).toBe(false))
      const channels = vi.mocked(emitAgentEvent).mock.calls.map(call => call[0])
      expect(channels.filter(channel => channel === 'agent:complete')).toHaveLength(1)
      expect(channels.filter(channel => channel === 'agent:turn-start')).toHaveLength(hook === 'onTurnStart' ? 0 : 1)
      expect(sink.onConsumerStopped).toHaveBeenCalledTimes(1)
      expect(sink.onTurnComplete).toHaveBeenCalledTimes(hook === 'onTurnComplete' ? 1 : 0)
      expect(sink.onTurnError).toHaveBeenCalledTimes(hook === 'onTurnError' ? 1 : 0)
      expect(readSnapshot).toHaveBeenCalledTimes(hook === 'onTurnComplete' ? 0 : 1)
      expect(sink.onConsumerStopped).toHaveBeenCalledWith(hook === 'onTurnStart' ? partial : undefined)
      if (hook === 'onTurnError') expect(sink.onTurnError).toHaveBeenCalledWith(expect.any(Error), true, partial)
      expect(consumePendingRebuild).not.toHaveBeenCalled()
      consumer.stop()
      expect(vi.mocked(emitAgentEvent).mock.calls.filter(call => call[0] === 'agent:complete')).toHaveLength(1)
    } finally {
      consumer.stop()
      resolve({} as StreamResult)
    }
  })
})
