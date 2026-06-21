/**
 * Unit tests for apps/runtime/im-channels/wecom-stream-session.
 *
 * Covers the contracts that protect against the original incident:
 *   - Intermediate updates route to replyStreamNonBlocking (not the blocking
 *     replyStream), so back-pressure can skip stale frames.
 *   - The finish() call routes to replyStreamFinish (blocking) so the final
 *     answer is queued, sent, and acked before the session is torn down.
 *   - UTF-8 cleansing runs over every text payload, with cumulative reporting.
 *   - When the stream channel is marked broken before finish(), the session
 *     falls back to queuePush() for the final answer instead of silently
 *     attempting another stream frame.
 *   - dispose() yields a terminal log without sending anything.
 *
 * The session is constructed with a fake StreamingTransport that records
 * every call — no SDK, no WebSocket, no timers.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  WecomStreamSession,
  type StreamingTransport,
  type StreamLogger,
} from '../../../../../src/main/apps/runtime/im-channels/wecom-stream-session'

// ============================================
// Test fakes
// ============================================

interface RecordedCall {
  method:
    | 'replyStreamNonBlocking'
    | 'replyStreamFinish'
    | 'queuePush'
  args: unknown[]
}

interface FakeTransport extends StreamingTransport {
  calls: RecordedCall[]
  nextNonBlocking: 'sent' | 'skipped' | 'failed'
  nextFinish: 'sent' | 'failed'
  nextPush: boolean
  authenticated: boolean
}

function makeTransport(overrides: Partial<FakeTransport> = {}): FakeTransport {
  const t: FakeTransport = {
    calls: [],
    nextNonBlocking: 'sent',
    nextFinish: 'sent',
    nextPush: true,
    authenticated: true,
    replyStreamNonBlocking: async (frame, streamId, content) => {
      t.calls.push({
        method: 'replyStreamNonBlocking',
        args: [frame, streamId, content],
      })
      return t.nextNonBlocking
    },
    replyStreamFinish: async (frame, streamId, content) => {
      t.calls.push({
        method: 'replyStreamFinish',
        args: [frame, streamId, content],
      })
      return t.nextFinish
    },
    queuePush: async (chatId, text, chatType, tag, trace) => {
      t.calls.push({
        method: 'queuePush',
        args: [chatId, text, chatType, tag, trace],
      })
      return t.nextPush
    },
    isAuthenticated: () => t.authenticated,
    ...overrides,
  }
  return t
}

function makeLogger(): { logger: StreamLogger; events: string[] } {
  const events: string[] = []
  const logger: StreamLogger = (level, event) => {
    events.push(`${level}:${event}`)
  }
  return { logger, events }
}

function makeSession(transport: StreamingTransport, logger: StreamLogger) {
  return new WecomStreamSession({
    frame: { headers: { req_id: 'req-test-1' } },
    streamId: 'stream-test-1',
    chatId: 'chat-1',
    chatType: 'direct',
    trace: 'trace-1',
    transport,
    logger,
  })
}

// ============================================
// Tests
// ============================================

describe('WecomStreamSession.update', () => {
  let transport: FakeTransport
  let events: string[]

  beforeEach(() => {
    transport = makeTransport()
    const l = makeLogger()
    events = l.events
    ;(transport as unknown as { __logger: StreamLogger }).__logger = l.logger
  })

  it('routes intermediate text_delta to replyStreamNonBlocking', async () => {
    const { logger } = makeLogger()
    const session = makeSession(transport, logger)
    await session.update({ type: 'text_delta', text: 'hello' })
    const nonBlocking = transport.calls.filter(
      (c) => c.method === 'replyStreamNonBlocking',
    )
    expect(nonBlocking).toHaveLength(1)
    // Content should include the answer text — no `<think>` block yet since
    // we haven't pushed any progress events.
    const content = nonBlocking[0].args[2] as string
    expect(content).toContain('hello')
    expect(content.startsWith('<think>')).toBe(false)
  })

  it('builds <think> block from tool_call / tool_result / thinking events', async () => {
    const { logger } = makeLogger()
    const session = makeSession(transport, logger)
    await session.update({ type: 'thinking', text: 'analysing' })
    await session.update({
      type: 'tool_call',
      tool: 'Bash',
      summary: 'run command',
    })
    await session.update({
      type: 'tool_result',
      tool: 'Bash',
      summary: 'exit 0',
      success: true,
    })
    await session.update({ type: 'text_delta', text: 'final answer' })

    const lastCall = transport.calls[transport.calls.length - 1]
    const content = lastCall.args[2] as string
    expect(content).toMatch(/<think>[\s\S]+<\/think>/)
    expect(content).toContain('💭 analysing')
    expect(content).toContain('⚙️ run command') // Bash icon
    expect(content).toContain('✅ exit 0')
    expect(content).toContain('final answer')
  })

  it('respects back-pressure: skipped result emits log event without growing sent counter', async () => {
    const { logger, events: logs } = makeLogger()
    const session = makeSession(transport, logger)
    transport.nextNonBlocking = 'skipped'
    await session.update({ type: 'text_delta', text: 'pending' })
    expect(logs.some((e) => e.includes('stream_packet_skipped'))).toBe(true)
    expect(logs.some((e) => e.includes('stream_packet_sent'))).toBe(false)
  })

  it('marks stream broken when non-blocking returns failed', async () => {
    const { logger, events: logs } = makeLogger()
    const session = makeSession(transport, logger)
    transport.nextNonBlocking = 'failed'
    await session.update({ type: 'text_delta', text: 'oops' })
    expect(logs.some((e) => e.startsWith('warn:stream_broken'))).toBe(true)
  })

  it('falls back to queuePush after stream is broken', async () => {
    const { logger } = makeLogger()
    const session = makeSession(transport, logger)
    session.markStreamBroken('test setup')
    await session.update({
      type: 'tool_call',
      tool: 'Read',
      summary: 'read file',
    })
    // Default throttle blocks immediate progress push; trigger finish to
    // force the push path.
    await session.finish('final answer')
    const pushes = transport.calls.filter((c) => c.method === 'queuePush')
    expect(pushes.length).toBeGreaterThanOrEqual(1)
  })
})

describe('WecomStreamSession.finish', () => {
  it('routes finish=true to the blocking replyStreamFinish path', async () => {
    const transport = makeTransport()
    const { logger } = makeLogger()
    const session = makeSession(transport, logger)
    await session.update({ type: 'text_delta', text: 'incremental' })
    await session.finish('FINAL ANSWER')

    const finishCalls = transport.calls.filter(
      (c) => c.method === 'replyStreamFinish',
    )
    expect(finishCalls).toHaveLength(1)
    const [frame, streamId, content] = finishCalls[0].args as [
      { headers: { req_id: string } },
      string,
      string,
    ]
    expect(frame.headers.req_id).toBe('req-test-1')
    expect(streamId).toBe('stream-test-1')
    expect(content).toContain('FINAL ANSWER')
  })

  it('falls back to queuePush when replyStreamFinish fails', async () => {
    const transport = makeTransport({
      nextFinish: 'failed' as const,
    } as Partial<FakeTransport>)
    const { logger } = makeLogger()
    const session = makeSession(transport, logger)
    await session.finish('FINAL ANSWER')

    const pushes = transport.calls.filter((c) => c.method === 'queuePush')
    expect(pushes).toHaveLength(1)
    expect(pushes[0].args[1]).toBe('FINAL ANSWER')
  })

  it('uses queuePush directly when not authenticated', async () => {
    const transport = makeTransport({ authenticated: false })
    const { logger } = makeLogger()
    const session = makeSession(transport, logger)
    await session.finish('hello')
    expect(transport.calls).toHaveLength(1)
    expect(transport.calls[0].method).toBe('queuePush')
  })

  it('logs terminal summary exactly once', async () => {
    const transport = makeTransport()
    const { logger, events } = makeLogger()
    const session = makeSession(transport, logger)
    await session.finish('done')
    await session.finish('again') // should be a no-op
    const closes = events.filter((e) => e.endsWith(':stream_close'))
    expect(closes).toHaveLength(1)
  })
})

describe('WecomStreamSession.dispose', () => {
  it('marks the session as ended and emits a terminal summary', async () => {
    const transport = makeTransport()
    const { logger, events } = makeLogger()
    const session = makeSession(transport, logger)
    session.dispose()
    const closes = events.filter((e) => e.endsWith(':stream_close'))
    expect(closes).toHaveLength(1)
    // No transport calls — dispose never sends.
    expect(transport.calls).toHaveLength(0)

    // Subsequent updates are silently ignored.
    await session.update({ type: 'text_delta', text: 'ignored' })
    expect(transport.calls).toHaveLength(0)
  })
})

describe('WecomStreamSession UTF-8 cleansing', () => {
  it('emits a sanitization log when invalid UTF-8 sequences are encountered', async () => {
    const transport = makeTransport()
    const { logger, events } = makeLogger()
    const session = makeSession(transport, logger)
    // Lone high surrogate — round-trip via Buffer produces U+FFFD.
    await session.update({ type: 'text_delta', text: '\uD800 dangling' })
    expect(
      events.some((e) => e.includes('stream_content_utf8_sanitized')),
    ).toBe(true)
  })

  it('preserves emojis whose surrogate pair spans two text_delta chunks', async () => {
    // Regression: previously each chunk was sanitized in isolation, turning
    // a lone high surrogate (first chunk) and lone low surrogate (second
    // chunk) into two U+FFFD characters and permanently corrupting the
    // rocket emoji 🚀 (U+1F680 = "\uD83D\uDE80"). The fix defers sanitize
    // to output assembly, after both halves are concatenated.
    const transport = makeTransport()
    const { logger } = makeLogger()
    const session = makeSession(transport, logger)
    await session.update({ type: 'text_delta', text: 'Launch \uD83D' })
    await session.update({ type: 'text_delta', text: '\uDE80 now' })
    const nonBlocking = transport.calls.filter(
      (c) => c.method === 'replyStreamNonBlocking',
    )
    expect(nonBlocking).toHaveLength(2)
    // After the second chunk arrives, the assembled content should contain
    // the intact emoji and no extraneous replacement characters.
    const secondContent = nonBlocking[1].args[2] as string
    expect(secondContent).toContain('Launch 🚀 now')
    expect(secondContent.includes('\uFFFD')).toBe(false)
  })

  it('reports new UTF-8 replacements only once across multiple frames', async () => {
    // A genuinely-corrupt chunk should fire stream_content_utf8_sanitized
    // once at first detection, not on every subsequent frame.
    const transport = makeTransport()
    const { logger, events } = makeLogger()
    const session = makeSession(transport, logger)
    await session.update({ type: 'text_delta', text: '\uD800 bad' })
    await session.update({ type: 'text_delta', text: ' more clean text' })
    const sanitizeLogs = events.filter((e) =>
      e.includes('stream_content_utf8_sanitized'),
    )
    expect(sanitizeLogs).toHaveLength(1)
  })
})

describe('WecomStreamSession 10-minute cutoff fallback', () => {
  it('pushes the transition notice when the finish frame fails on cutoff', async () => {
    // When the proactive transition tries to gracefully end the stream and
    // the finish frame itself fails, the user must still see continuity —
    // we expect a discrete push carrying the transition notice.
    vi.useFakeTimers()
    try {
      const t0 = new Date('2026-01-01T00:00:00Z').getTime()
      vi.setSystemTime(t0)
      const transport = makeTransport({
        nextFinish: 'failed' as const,
      } as Partial<FakeTransport>)
      const { logger, events } = makeLogger()
      const session = makeSession(transport, logger)

      // Advance well past the (lifetime - safety_margin) threshold so the
      // next update() triggers transitionToPushMode().
      vi.setSystemTime(t0 + 10 * 60_000 - 10_000) // 9m50s elapsed
      await session.update({ type: 'text_delta', text: 'late chunk' })

      const finishFrames = transport.calls.filter(
        (c) => c.method === 'replyStreamFinish',
      )
      expect(finishFrames).toHaveLength(1)

      const pushes = transport.calls.filter((c) => c.method === 'queuePush')
      expect(pushes.length).toBeGreaterThanOrEqual(1)
      // Verify the pushed text is the transition notice (trimmed).
      const noticePush = pushes.find((p) =>
        (p.args[1] as string).includes('企微协议限制单条流式消息最长 10 分钟'),
      )
      expect(noticePush).toBeDefined()
      expect(
        events.some((e) => e.includes('stream_transition_notice_pushed')),
      ).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('WecomStreamSession.maybePushProgress', () => {
  it('does not push when progressLines is empty', async () => {
    const transport = makeTransport()
    const { logger } = makeLogger()
    const session = makeSession(transport, logger)
    session.markStreamBroken('test setup')
    
    // No progress events added, so progressLines is empty
    await session.finish('done')
    
    const pushes = transport.calls.filter((c) => c.method === 'queuePush')
    // Should only have the final answer push, not a progress push
    expect(pushes).toHaveLength(1)
    expect(pushes[0].args[1]).toBe('done')
  })

  it('throttles progress pushes at 2-minute intervals', async () => {
    vi.useFakeTimers()
    try {
      const t0 = new Date('2026-01-01T00:00:00Z').getTime()
      vi.setSystemTime(t0)
      
      const transport = makeTransport()
      const { logger, events } = makeLogger()
      const session = makeSession(transport, logger)
      
      // Mark stream as broken to trigger push mode
      session.markStreamBroken('test')
      
      // Add progress events
      await session.update({ type: 'tool_call', tool: 'Read', summary: 'reading file' })
      
      // First push should happen immediately (lastProgressPushAt starts at 0)
      const pushes1 = transport.calls.filter((c) => c.method === 'queuePush')
      expect(pushes1.length).toBeGreaterThanOrEqual(1)
      
      // Advance less than 2 minutes
      vi.setSystemTime(t0 + 60_000) // 1 minute
      await session.update({ type: 'tool_call', tool: 'Bash', summary: 'running command' })
      
      // Should NOT push again (throttled)
      const pushes2 = transport.calls.filter((c) => c.method === 'queuePush')
      const progressPushes = pushes2.filter(p => 
        (p.args[1] as string).includes('任务进行中')
      )
      expect(progressPushes).toHaveLength(1) // Still just the first one
    } finally {
      vi.useRealTimers()
    }
  })

  it('pushes progress after throttle interval elapses', async () => {
    vi.useFakeTimers()
    try {
      const t0 = new Date('2026-01-01T00:00:00Z').getTime()
      vi.setSystemTime(t0)
      
      const transport = makeTransport()
      const { logger } = makeLogger()
      const session = makeSession(transport, logger)
      
      session.markStreamBroken('test')
      
      // Add progress event
      await session.update({ type: 'tool_call', tool: 'Read', summary: 'first' })
      
      // Advance past the 2-minute throttle interval
      vi.setSystemTime(t0 + 2 * 60_000 + 1000) // 2 minutes + 1 second
      
      // Add another progress event - should trigger a new push
      await session.update({ type: 'tool_call', tool: 'Write', summary: 'second' })
      
      const progressPushes = transport.calls.filter(p => 
        p.method === 'queuePush' && (p.args[1] as string).includes('任务进行中')
      )
      expect(progressPushes.length).toBeGreaterThanOrEqual(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('formats push text with last 3 progress lines', async () => {
    const transport = makeTransport()
    const { logger } = makeLogger()
    const session = makeSession(transport, logger)
    
    session.markStreamBroken('test')
    
    // Add more than 3 progress events
    await session.update({ type: 'tool_call', tool: 'Read', summary: 'first' })
    await session.update({ type: 'tool_call', tool: 'Edit', summary: 'second' })
    await session.update({ type: 'tool_call', tool: 'Write', summary: 'third' })
    await session.update({ type: 'tool_call', tool: 'Bash', summary: 'fourth' })
    
    const progressPushes = transport.calls.filter(p => 
      p.method === 'queuePush' && (p.args[1] as string).includes('任务进行中')
    )
    
    expect(progressPushes.length).toBeGreaterThanOrEqual(1)
    
    const pushText = progressPushes[0].args[1] as string
    
    // Should include the prefix
    expect(pushText).toContain('_(任务进行中)_')
    
    // Should only include last 3 lines
    expect(pushText).not.toContain('first')
    expect(pushText).toContain('second')
    expect(pushText).toContain('third')
    expect(pushText).toContain('fourth')
  })

  it('increments progressPushesSent counter on each push', async () => {
    vi.useFakeTimers()
    try {
      const t0 = new Date('2026-01-01T00:00:00Z').getTime()
      vi.setSystemTime(t0)
      
      const transport = makeTransport()
      const { logger, events } = makeLogger()
      const session = makeSession(transport, logger)
      
      session.markStreamBroken('test')
      
      // First push
      await session.update({ type: 'tool_call', tool: 'Read', summary: 'first' })
      
      // Check for stream_progress_push log with seq=1
      expect(events.some(e => e.includes('stream_progress_push'))).toBe(true)
      
      // Advance past throttle
      vi.setSystemTime(t0 + 3 * 60_000)
      
      // Second push
      await session.update({ type: 'tool_call', tool: 'Write', summary: 'second' })
      
      // Verify we have multiple stream_progress_push logs
      const progressLogs = events.filter(e => e.includes('stream_progress_push'))
      expect(progressLogs.length).toBeGreaterThanOrEqual(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('logs push with correct metadata (seq, bytes, elapsedMs)', async () => {
    vi.useFakeTimers()
    try {
      const t0 = new Date('2026-01-01T00:00:00Z').getTime()
      vi.setSystemTime(t0)
      
      const transport = makeTransport()
      const { logger } = makeLogger()
      const loggedEvents: Array<{level: string, event: string, fields: Record<string, unknown>}> = []
      const trackingLogger = (level: string, event: string, fields: Record<string, unknown>) => {
        loggedEvents.push({ level, event, fields })
      }
      const session = makeSession(transport, trackingLogger)
      
      session.markStreamBroken('test')
      await session.update({ type: 'tool_call', tool: 'Read', summary: 'reading' })
      
      const progressLog = loggedEvents.find(e => e.event === 'stream_progress_push')
      expect(progressLog).toBeDefined()
      expect(progressLog!.fields.seq).toBe(1)
      expect(progressLog!.fields.bytes).toBeGreaterThan(0)
      expect(progressLog!.fields.elapsedMs).toBeGreaterThanOrEqual(0)
      expect(progressLog!.fields.trace).toBe('trace-1')
      expect(progressLog!.fields.streamId).toBe('stream-test-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('includes correct source tag in queuePush call', async () => {
    const transport = makeTransport()
    const { logger } = makeLogger()
    const session = makeSession(transport, logger)
    
    session.markStreamBroken('test')
    await session.update({ type: 'tool_call', tool: 'Read', summary: 'reading' })
    
    const progressPushes = transport.calls.filter(p => 
      p.method === 'queuePush' && (p.args[1] as string).includes('任务进行中')
    )
    
    expect(progressPushes.length).toBeGreaterThanOrEqual(1)
    
    // Verify sourceTag parameter
    const sourceTag = progressPushes[0].args[3] as string
    expect(sourceTag).toBe('stream:stream-test-1')
  })

  it('handles tool_result events in progress lines', async () => {
    const transport = makeTransport()
    const { logger } = makeLogger()
    const session = makeSession(transport, logger)
    
    session.markStreamBroken('test')
    
    await session.update({ type: 'tool_call', tool: 'Read', summary: 'reading' })
    await session.update({ type: 'tool_result', tool: 'Read', summary: 'done', success: true })
    
    const progressPushes = transport.calls.filter(p => 
      p.method === 'queuePush' && (p.args[1] as string).includes('任务进行中')
    )
    
    expect(progressPushes.length).toBeGreaterThanOrEqual(1)
    
    const pushText = progressPushes[0].args[1] as string
    expect(pushText).toContain('📖') // Read icon
    expect(pushText).toContain('✅') // Success icon
  })
})

describe('WecomStreamSession instrumentation', () => {
  it('exposes the trace id for log correlation', () => {
    const transport = makeTransport()
    const { logger } = makeLogger()
    const session = makeSession(transport, logger)
    expect(session.getTraceId()).toBe('trace-1')
  })

  it('uses vi.fn shape sanity — internal smoke check', () => {
    // Sanity that vi imported correctly (will appear as a no-op if not).
    const spy = vi.fn()
    spy('ok')
    expect(spy).toHaveBeenCalledWith('ok')
  })
})
