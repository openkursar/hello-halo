/**
 * Unit Tests: services/agent/dsh — Session Adapter.
 *
 * Covers the two things the adapter owns beyond the normalizer: the turn
 * interval (prompt receipt → the session's next whole-agent idle) and the
 * filtering of a notification stream that carries every session in the
 * runtime. The runtime client is faked through the `DshRuntimeClient` seam,
 * so no child process is involved.
 */

import { describe, expect, it } from 'vitest'
import { DshSession } from '../../../../../src/main/services/agent/dsh/session-adapter'
import type { DshNotification, DshRuntimeClient } from '../../../../../src/main/services/agent/dsh/types'
import { inboxReceipt, sessionStatus, textTurn, toolTurn } from './fixtures'

const SESSION = 'sess-a'

class FakeRuntimeClient implements DshRuntimeClient {
  readonly prompts: Array<{ sessionId: string; contentBlocks: unknown[] }> = []
  closed = false
  private handlers = new Set<(notification: DshNotification) => void>()
  private nextMessageId = 0

  /** Emit notifications from inside `prompt()`, before its response resolves. */
  promptHook: (() => void) | null = null

  async initialize(): Promise<void> {}

  async prompt(sessionId: string, contentBlocks: unknown[]): Promise<{ messageId: string }> {
    this.prompts.push({ sessionId, contentBlocks })
    this.promptHook?.()
    return { messageId: `msg-${++this.nextMessageId}` }
  }

  onNotification(handler: (notification: DshNotification) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  async close(): Promise<void> {
    this.closed = true
  }

  /** Push notifications the way the transport would. */
  emit(...notifications: DshNotification[]): void {
    for (const notification of notifications) {
      for (const handler of this.handlers) handler(notification)
    }
  }
}

async function createSession(): Promise<{ session: DshSession; runtime: FakeRuntimeClient }> {
  const runtime = new FakeRuntimeClient()
  const session = await DshSession.create({
    resume: SESSION,
    model: 'deepseek-v4',
    provider: 'deepseek-official',
    cwd: '/tmp',
    runtimeClientFactory: () => runtime,
  })
  return { session, runtime }
}

/** Collect one turn's frames; `stream()` returns of its own accord at `result`. */
async function collectTurn(session: DshSession): Promise<any[]> {
  const frames: any[] = []
  for await (const frame of session.stream()) frames.push(frame)
  return frames
}

/** Let the microtask queue settle so `send()`'s async dispatch has run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('DshSession — turn interval', () => {
  it('opens the turn only when the prompt receipt arrives', async () => {
    const { session, runtime } = await createSession()
    const collected = collectTurn(session)

    session.send('hello')
    await settle()

    // Activity that predates our receipt belongs to earlier work.
    runtime.emit(...textTurn(SESSION))
    runtime.emit(inboxReceipt(SESSION, 'msg-1'))
    runtime.emit(...textTurn(SESSION), sessionStatus(SESSION, 'idle'))

    const frames = await collected
    expect(frames[0]).toMatchObject({ type: 'system', subtype: 'init' })
    expect(frames.filter((f) => f.type === 'system' && f.subtype === 'init')).toHaveLength(1)
    expect(frames.at(-1)).toMatchObject({ type: 'result', subtype: 'success' })
  })

  it('closes the turn on its own session going idle, and yields exactly one result', async () => {
    const { session, runtime } = await createSession()
    const collected = collectTurn(session)

    session.send('hello')
    await settle()
    runtime.emit(inboxReceipt(SESSION, 'msg-1'), ...toolTurn(SESSION))
    // A descendant or unrelated session going idle must not end our turn.
    runtime.emit(sessionStatus('other-session', 'idle'))
    runtime.emit(sessionStatus(SESSION, 'idle'))

    const frames = await collected
    expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
    expect(frames.at(-1).type).toBe('result')
  })

  it('drops events belonging to an unrelated session', async () => {
    const { session, runtime } = await createSession()
    const collected = collectTurn(session)

    session.send('hello')
    await settle()
    runtime.emit(inboxReceipt(SESSION, 'msg-1'))
    runtime.emit(...textTurn('other-session'), sessionStatus('other-session', 'idle'))
    runtime.emit(...textTurn(SESSION), sessionStatus(SESSION, 'idle'))

    const frames = await collected
    const deltas = frames
      .filter((f) => f.type === 'stream_event' && f.event.delta?.type === 'text_delta')
      .map((f) => f.event.delta.text)
    expect(deltas).toEqual(['Hello', ' world'])
  })

  it('serializes a second prompt until the first interval has closed', async () => {
    const { session, runtime } = await createSession()
    const firstTurn = collectTurn(session)

    session.send('one')
    session.send('two')
    await settle()
    expect(runtime.prompts).toHaveLength(1)

    runtime.emit(inboxReceipt(SESSION, 'msg-1'), ...textTurn(SESSION), sessionStatus(SESSION, 'idle'))
    await firstTurn
    await settle()

    expect(runtime.prompts).toHaveLength(2)
    expect(runtime.prompts[1].contentBlocks).toEqual([{ type: 'text', text: 'two' }])

    const secondTurn = collectTurn(session)
    runtime.emit(inboxReceipt(SESSION, 'msg-2'), ...textTurn(SESSION), sessionStatus(SESSION, 'idle'))
    const frames = await secondTurn
    expect(frames[0]).toMatchObject({ type: 'system', subtype: 'init' })
    expect(frames.at(-1)).toMatchObject({ type: 'result' })
  })

  it('sends multi-modal content as its text blocks only', async () => {
    const { session, runtime } = await createSession()
    session.send({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: {} }] },
    })
    await settle()
    expect(runtime.prompts[0].contentBlocks).toEqual([{ type: 'text', text: 'look' }])
  })
})

describe('DshSession — lifecycle', () => {
  it('reports readiness until closed', async () => {
    const { session } = await createSession()
    expect(session.query.transport.isReady()).toBe(true)
    expect(session.query.transport.ready).toBe(true)
    await session.close()
    expect(session.query.transport.isReady()).toBe(false)
  })

  it('exposes an empty slash-command surface for warmup', async () => {
    const { session } = await createSession()
    await expect(session.query.supportedCommands()).resolves.toEqual([])
  })

  it('settles the open turn and closes the runtime on interrupt', async () => {
    const { session, runtime } = await createSession()
    const collected = collectTurn(session)

    session.send('hello')
    await settle()
    runtime.emit(inboxReceipt(SESSION, 'msg-1'), ...textTurn(SESSION))
    await session.interrupt()

    const frames = await collected
    expect(frames.at(-1)).toMatchObject({ type: 'result', is_error: true })
    expect(runtime.closed).toBe(true)
    expect(session.query.transport.isReady()).toBe(false)
  })

  it('opens the turn when the receipt overtakes the prompt response', async () => {
    // What a real runtime does: it starts working the instant it accepts the
    // prompt, so the receipt and the first events reach the client before the
    // `session/prompt` response that names the message id.
    const runtime = new FakeRuntimeClient()
    runtime.promptHook = () => runtime.emit(
      inboxReceipt(SESSION, 'msg-1'),
      ...textTurn(SESSION),
      sessionStatus(SESSION, 'idle'),
    )

    const session = await DshSession.create({
      resume: SESSION,
      model: 'deepseek-v4',
      provider: 'deepseek-official',
      cwd: '/tmp',
      runtimeClientFactory: () => runtime,
    })
    const collected = collectTurn(session)

    session.send('hello')

    const frames = await collected
    expect(frames[0]).toMatchObject({ type: 'system', subtype: 'init' })
    expect(frames.at(-1)).toMatchObject({ type: 'result' })
  })

  it('refuses to send after close', async () => {
    const { session } = await createSession()
    await session.close()
    expect(() => session.send('hi')).toThrow(/closed/)
  })

  it('fails fast when no runtime factory has been registered', async () => {
    await expect(DshSession.create({ model: 'deepseek-v4' })).rejects.toThrow(/runtime client factory/)
  })
})
