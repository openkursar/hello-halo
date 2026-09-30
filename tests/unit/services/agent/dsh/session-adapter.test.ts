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
  private exitHandlers = new Set<(error?: Error) => void>()
  private childExited = false
  private nextMessageId = 0

  /** Emit notifications from inside `prompt()`, before its response resolves. */
  promptHook: (() => void) | null = null
  /** Reject `initialize()` to exercise the failed-start path. */
  initializeError: Error | null = null

  async initialize(): Promise<void> {
    if (this.initializeError) throw this.initializeError
  }

  async prompt(sessionId: string, contentBlocks: unknown[]): Promise<{ messageId: string }> {
    this.prompts.push({ sessionId, contentBlocks })
    this.promptHook?.()
    return { messageId: `msg-${++this.nextMessageId}` }
  }

  onNotification(handler: (notification: DshNotification) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  isAlive(): boolean {
    return !this.closed && !this.childExited
  }

  onExit(handler: (error?: Error) => void): () => void {
    this.exitHandlers.add(handler)
    return () => this.exitHandlers.delete(handler)
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

  /** Kill the child the way an unexpected runtime exit would. */
  crash(error = new Error('runtime exited unexpectedly')): void {
    this.childExited = true
    for (const handler of Array.from(this.exitHandlers)) handler(error)
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

  it('settles the turn with an error when the runtime refuses the prompt', async () => {
    // A refused prompt never produces the receipt that opens a turn; without
    // an explicit result the consumer would wait on stream() forever.
    const { session, runtime } = await createSession()
    runtime.prompt = async () => { throw new Error('session "s" already exists') }
    const collected = collectTurn(session)

    session.send('hello')

    const frames = await collected
    expect(frames[0]).toMatchObject({ type: 'system', subtype: 'init' })
    expect(frames.at(-1)).toMatchObject({ type: 'result', is_error: true })
    expect(frames.at(-1).result).toContain('already exists')
  })

  it('sends text and images in order, images inline', async () => {
    const { session, runtime } = await createSession()
    session.send({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/bmp', data: 'Qk0' } },
        ],
      },
    })
    await settle()
    // A raster type the protocol cannot admit is left out rather than failing the prompt.
    expect(runtime.prompts[0].contentBlocks).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', data: 'iVBOR', mimeType: 'image/png' },
    ])
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

/**
 * `session-manager.ts` decides whether to reuse a session by polling
 * `query.transport.isReady()`, and tears one down through
 * `query.transport.onExit()`. A dsh runtime cannot be restarted, so both have
 * to answer for the child process rather than for the adapter object.
 */
describe('DshSession — child liveness', () => {
  it('reports ready while the runtime is up', async () => {
    const { session } = await createSession()
    expect(session.query.transport.isReady()).toBe(true)
    expect(session.query.transport.ready).toBe(true)
  })

  it('stops reporting ready once the runtime dies on its own', async () => {
    const { session, runtime } = await createSession()

    runtime.crash()

    expect(session.query.transport.isReady()).toBe(false)
  })

  it('notifies the owner when the runtime dies on its own', async () => {
    const { session, runtime } = await createSession()
    const seen: Array<Error | undefined> = []
    session.query.transport.onExit?.((error) => seen.push(error))

    runtime.crash(new Error('boom'))

    expect(seen).toHaveLength(1)
    expect(seen[0]?.message).toBe('boom')
  })

  it('reports the exit once, not twice, when a dead runtime is then closed', async () => {
    const { session, runtime } = await createSession()
    let calls = 0
    session.query.transport.onExit?.(() => { calls++ })

    runtime.crash()
    await session.close()

    expect(calls).toBe(1)
  })

  it('stops the child when the handshake fails, leaving no orphan behind', async () => {
    const runtime = new FakeRuntimeClient()
    runtime.initializeError = new Error('handshake rejected')

    await expect(
      DshSession.create({
        resume: SESSION,
        model: 'deepseek-v4',
        cwd: '/tmp',
        runtimeClientFactory: () => runtime,
      }),
    ).rejects.toThrow(/handshake rejected/)

    expect(runtime.closed).toBe(true)
  })
})
