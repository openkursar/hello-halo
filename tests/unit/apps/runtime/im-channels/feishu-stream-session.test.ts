/**
 * Unit tests for apps/runtime/im-channels/feishu-stream-session.
 *
 * The session bridges Halo's push-style StreamingHandle onto the Feishu SDK's
 * producer-style streaming card. What must hold, in order of how badly a user
 * feels the regression:
 *
 *   1. The final answer is ALWAYS delivered — via the card, or via a plain
 *      message when the card never opened / broke, and it throws only when both
 *      fail. A silently dropped answer looks like the bot ignored the user.
 *   2. finish() closes the card: it writes the final content and lets the SDK's
 *      producer return, otherwise the card stays open forever.
 *   3. Live content shows progress and the partial answer; the final content
 *      carries only the answer (no leftover tool noise).
 *   4. Writes coalesce, so a fast token stream cannot queue a backlog of stale
 *      patches.
 *   5. dispose() abandons without sending, and is safe twice.
 */

import { describe, it, expect, vi } from 'vitest'
import { FeishuStreamSession } from '../../../../../src/main/apps/runtime/im-channels/feishu-stream-session'
import type { FeishuStreamController } from '../../../../../src/main/apps/runtime/im-channels/feishu-stream-session'

interface Harness {
  session: FeishuStreamSession
  /** Every content value the card was asked to render, in order. */
  writes: string[]
  plainSends: string[]
  /** Resolves once the SDK-side producer has returned (card closed). */
  producerDone: () => boolean
  disposed: () => number
}

function makeHarness(opts: {
  openFails?: boolean
  writeFails?: boolean
  plainFails?: boolean
} = {}): Harness {
  const writes: string[] = []
  const plainSends: string[] = []
  let producerReturned = false
  let disposeCount = 0

  const session = new FeishuStreamSession({
    chatId: 'oc_chat',
    trace: 'trace-1',
    logger: () => {},
    onDispose: () => { disposeCount++ },
    transport: {
      openStream: async (producer) => {
        if (opts.openFails) throw new Error('card creation refused')
        const controller: FeishuStreamController = {
          setContent: async (full: string) => {
            if (opts.writeFails) throw new Error('element exceeds the limit')
            writes.push(full)
          },
        }
        await producer(controller)
        producerReturned = true
      },
      sendPlain: async (text: string) => {
        if (opts.plainFails) return false
        plainSends.push(text)
        return true
      },
    },
  })

  return {
    session,
    writes,
    plainSends,
    producerDone: () => producerReturned,
    disposed: () => disposeCount,
  }
}

describe('FeishuStreamSession — happy path', () => {
  it('renders progress and partial answer live, then only the answer at finish', async () => {
    const h = makeHarness()

    await h.session.update({ type: 'status', text: 'Received, working on it' })
    await h.session.update({ type: 'tool_call', tool: 'Read', summary: 'notes.md' })
    await h.session.update({ type: 'text_delta', text: 'Here is ' })
    await h.session.update({ type: 'text_delta', text: 'the answer' })
    await flush()

    const live = h.writes[h.writes.length - 1]
    expect(live).toContain('Received, working on it')
    expect(live).toContain('Read')
    expect(live).toContain('Here is the answer')

    await h.session.finish('Here is the answer')

    const final = h.writes[h.writes.length - 1]
    expect(final).toBe('Here is the answer')
    // No tool noise survives into the answer the user keeps.
    expect(final).not.toContain('Read')
    // The producer returned, so the SDK finalized the card.
    expect(h.producerDone()).toBe(true)
    expect(h.plainSends).toHaveLength(0)
    expect(h.disposed()).toBe(1)
  })

  it('coalesces writes instead of queueing one patch per delta', async () => {
    const h = makeHarness()
    await h.session.update({ type: 'text_delta', text: 'a' })
    // Fire a burst without awaiting: only the newest state needs to land.
    void h.session.update({ type: 'text_delta', text: 'b' })
    void h.session.update({ type: 'text_delta', text: 'c' })
    void h.session.update({ type: 'text_delta', text: 'd' })
    await flush()

    expect(h.writes.length).toBeLessThan(4)
    expect(h.writes[h.writes.length - 1]).toContain('abcd')
  })

  it('keeps only the most recent progress lines', async () => {
    const h = makeHarness()
    for (let i = 0; i < 10; i++) {
      await h.session.update({ type: 'status', text: `step ${i}` })
    }
    await flush()
    const live = h.writes[h.writes.length - 1]
    expect(live).toContain('step 9')
    expect(live).not.toContain('step 0')
  })

  it('drops consecutive duplicate progress lines', async () => {
    const h = makeHarness()
    await h.session.update({ type: 'tool_call', tool: 'Bash', summary: 'ls' })
    await h.session.update({ type: 'tool_call', tool: 'Bash', summary: 'ls' })
    await flush()
    const live = h.writes[h.writes.length - 1]
    expect(live.split('Bash').length - 1).toBe(1)
  })
})

describe('FeishuStreamSession — delivery guarantees', () => {
  it('falls back to a plain message when the card cannot be opened', async () => {
    const h = makeHarness({ openFails: true })
    await h.session.update({ type: 'status', text: 'working' })
    await h.session.finish('final answer')

    expect(h.writes).toHaveLength(0)
    expect(h.plainSends).toEqual(['final answer'])
  })

  it('falls back when the card is marked broken mid-flight', async () => {
    const h = makeHarness()
    await h.session.update({ type: 'status', text: 'working' })
    await flush()
    h.session.markStreamBroken('long connection reconnecting')
    await h.session.finish('final answer')

    expect(h.plainSends).toEqual(['final answer'])
  })

  it('falls back when the closing write fails', async () => {
    const h = makeHarness({ writeFails: true })
    await h.session.update({ type: 'text_delta', text: 'partial' })
    await flush()
    await h.session.finish('final answer')

    expect(h.plainSends).toEqual(['final answer'])
  })

  it('throws when the card and the fallback both fail', async () => {
    const h = makeHarness({ openFails: true, plainFails: true })
    await h.session.update({ type: 'status', text: 'working' })
    await expect(h.session.finish('final answer')).rejects.toThrow(/fallback failed/i)
  })

  it('delivers via plain message when finish is the first call', async () => {
    const h = makeHarness()
    await h.session.finish('immediate answer')
    expect(h.writes).toHaveLength(0)
    expect(h.plainSends).toEqual(['immediate answer'])
  })
})

describe('FeishuStreamSession — teardown', () => {
  it('dispose abandons the card without sending, and is safe twice', async () => {
    const h = makeHarness()
    await h.session.update({ type: 'status', text: 'working' })
    await flush()

    h.session.dispose()
    h.session.dispose()
    await flush()

    expect(h.plainSends).toHaveLength(0)
    expect(h.producerDone()).toBe(true)
    expect(h.disposed()).toBe(1)
  })

  it('ignores updates after finish', async () => {
    const h = makeHarness()
    await h.session.finish('done')
    const before = h.writes.length
    await h.session.update({ type: 'text_delta', text: 'late' })
    await flush()
    expect(h.writes.length).toBe(before)
  })

  it('logs and returns instead of sending twice when finish is called again', async () => {
    const logs: string[] = []
    const session = new FeishuStreamSession({
      chatId: 'oc_chat',
      trace: 'trace-2',
      logger: (_level, event) => { logs.push(event) },
      transport: {
        openStream: async () => { /* never opened in this test */ },
        sendPlain: vi.fn(async () => true),
      },
    })
    await session.finish('first')
    await session.finish('second')
    expect(logs).toContain('stream_finish_after_close')
  })
})

/** Let queued microtasks and coalesced writes settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}
