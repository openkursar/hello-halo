/**
 * DeepSeek Harness session adapter.
 *
 * Bridges Halo's V2SDKSession contract (the Claude Code SDK shape) onto one
 * dsh runtime child process. One adapter instance == one harness session.
 *
 * Two properties of the harness protocol shape everything here:
 *
 *   1. `session/prompt` returns an enqueue receipt, not a turn result, and the
 *      runtime broadcasts events for EVERY session it hosts. A Halo turn is
 *      therefore not a protocol object: it is the activity interval the
 *      harness SDK defines — from the durable `agent/inbox/spliced` receipt
 *      carrying our message id, through the session's next whole-agent `idle`.
 *      This adapter owns that interval and filters the broadcast down to its
 *      own session plus the descendants `subagent.started` discloses.
 *
 *   2. There is no cancel method on the wire. `interrupt()` closes the runtime
 *      — see the method for what that costs.
 *
 * Like the Codex adapter, `stream()` is PER-TURN: each call yields one turn's
 * frames and returns once it has yielded the `result`. Halo's session-consumer
 * re-enters `stream()` for the next turn and emits `agent:complete` in between;
 * an iterator that never returns leaves the UI in the thinking state forever.
 * The frame queue is instance state, so nothing is lost across calls.
 */

import { randomUUID } from 'crypto'
import { DshEventNormalizer } from './event-normalizer'
import type { SdkMcpBridge } from '../mcp/sdk-bridge'
import type {
  DshInitializeParams,
  DshNotification,
  DshRuntimeClient,
  DshRuntimeLaunchSpec,
} from './types'

/**
 * Builds the wire client for one runtime child process. The transport half of
 * the adapter registers its implementation at wire-up; this half only ever
 * sees the `DshRuntimeClient` seam, which is what keeps the normalizer and the
 * turn-interval logic testable without a subprocess.
 */
export type DshRuntimeClientFactory = (
  launch: DshRuntimeLaunchSpec,
  init: DshInitializeParams,
) => DshRuntimeClient | Promise<DshRuntimeClient>

let registeredRuntimeFactory: DshRuntimeClientFactory | null = null

/** Register the transport's client factory. Called once at engine wire-up. */
export function setDshRuntimeClientFactory(factory: DshRuntimeClientFactory): void {
  registeredRuntimeFactory = factory
}

interface PendingPrompt {
  contentBlocks: unknown[]
}

export class DshSession {
  private readonly normalizer: DshEventNormalizer
  private readonly launch: DshRuntimeLaunchSpec
  private readonly init: DshInitializeParams
  private readonly factory: DshRuntimeClientFactory
  /**
   * Loopback server publishing Halo's in-process MCP tools to this runtime.
   * Held only to close it: the runtime dials it for the life of the session, so
   * it must not be shared and must not outlive the child.
   */
  private readonly mcpBridge: SdkMcpBridge | null
  private sessionId: string

  private client: DshRuntimeClient | null = null
  private unsubscribe: (() => void) | null = null
  private unsubscribeExit: (() => void) | null = null
  private closed = false
  private starting: Promise<void> | null = null

  private frameQueue: any[] = []
  private frameWaiters: Array<() => void> = []
  private queue: PendingPrompt[] = []
  private exitListeners = new Set<(error?: Error) => void>()
  private exitNotified = false

  /**
   * Message id of the prompt whose receipt opens the current interval. Set
   * between `session/prompt` returning and the receipt arriving; every
   * notification before the receipt belongs to earlier work and is dropped.
   */
  private awaitingReceiptFor: string | null = null
  /** True from the receipt until the session's next whole-agent idle. */
  private turnOpen = false
  /** True while a `session/prompt` call is in flight. */
  private dispatching = false
  /** Notifications that raced the in-flight `session/prompt` response. */
  private pendingWhileDispatching: DshNotification[] = []

  /**
   * Implements V2SDKSession.query — the CC SDK shape session-manager and
   * `ensureSessionWarm` probe:
   *
   *   - `transport.{isReady, ready, onExit}` drive liveness polling and
   *     teardown, and both answer for the child rather than for this object:
   *     a runtime that died on its own must not be handed back as a warm
   *     session, because it cannot be restarted.
   *   - `supportedCommands()` populates the slash-command palette during
   *     warmup. The harness has no slash-command surface, so this is a stable
   *     empty stub; without it warmup logs a TypeError on every conversation
   *     switch.
   */
  readonly query: {
    transport: {
      isReady: () => boolean
      ready: boolean
      onExit?: (cb: (error?: Error) => void) => () => void
    }
    supportedCommands: () => Promise<unknown[]>
  }

  private constructor(
    sessionId: string,
    launch: DshRuntimeLaunchSpec,
    init: DshInitializeParams,
    factory: DshRuntimeClientFactory,
    includePartialMessages: boolean,
    mcpBridge: SdkMcpBridge | null,
    mcpServerNames: string[],
  ) {
    this.sessionId = sessionId
    this.launch = launch
    this.init = init
    this.factory = factory
    this.mcpBridge = mcpBridge
    this.normalizer = new DshEventNormalizer({
      sessionId,
      model: init.model,
      includePartialMessages,
      mcpServerNames,
    })

    const isReady = (): boolean => !this.closed && this.client !== null && this.client.isAlive()
    this.query = {
      transport: {
        isReady,
        get ready() { return isReady() },
        onExit: (cb) => {
          this.exitListeners.add(cb)
          return () => this.exitListeners.delete(cb)
        },
      },
      supportedCommands: async () => [],
    }
  }

  static async create(sdkOptions: Record<string, any>): Promise<DshSession> {
    const factory = (sdkOptions.runtimeClientFactory as DshRuntimeClientFactory | undefined)
      ?? registeredRuntimeFactory
    if (!factory) {
      throw new Error('[dsh] No runtime client factory registered. Call setDshRuntimeClientFactory() at engine wire-up.')
    }
    const init: DshInitializeParams = {
      cwd: sdkOptions.cwd || process.cwd(),
      provider: sdkOptions.provider || 'deepseek-official',
      model: sdkOptions.model || '',
      ...(sdkOptions.maxTokens ? { maxTokens: sdkOptions.maxTokens as number } : {}),
    }
    const launch: DshRuntimeLaunchSpec = {
      command: sdkOptions.command || 'node',
      args: Array.isArray(sdkOptions.args) ? sdkOptions.args : [],
      env: (sdkOptions.env as Record<string, string>) || {},
      cwd: init.cwd,
    }
    // A resumed conversation replays Halo's persisted session id. The harness
    // creates the agent+session pair lazily on first prompt, so an id it has
    // never seen is valid input rather than an error.
    const sessionId = (sdkOptions.resume as string | undefined) || randomUUID()

    const session = new DshSession(
      sessionId,
      launch,
      init,
      factory,
      sdkOptions.includePartialMessages !== false,
      (sdkOptions.mcpBridge as SdkMcpBridge | undefined) ?? null,
      Array.isArray(sdkOptions.mcpServerNames) ? (sdkOptions.mcpServerNames as string[]) : [],
    )
    await session.start()
    return session
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  private start(): Promise<void> {
    if (!this.starting) this.starting = this.doStart()
    return this.starting
  }

  private async doStart(): Promise<void> {
    const client = await this.factory(this.launch, this.init)
    this.client = client

    try {
      this.unsubscribe = client.onNotification((notification) => this.onNotification(notification))
      this.unsubscribeExit = client.onExit((error) => this.notifyExit(error))
      await client.initialize(this.init)

      // `initialize` only configures the model route — the runtime answers it
      // while its plugin loader is still activating, so a prompt sent the instant
      // it returns reaches an agent whose MCP tools do not exist yet. Waiting for
      // the runtime's client to dial the bridge is the evidence that they do.
      // Halo warms sessions ahead of the first message, so this is normally paid
      // before anyone is waiting on it.
      await this.mcpBridge?.whenDialled()

      this.normalizer.setSessionId(this.sessionId)

      // Deliberately no `system.init` here. Per the CC SDK contract it is the
      // first frame of a streaming TURN, not a session-lifecycle event: emitting
      // it during warmup flips the renderer into the thinking state with no
      // `result` ever following. The normalizer emits it when a prompt receipt
      // actually opens an interval.
    } catch (err) {
      // The factory spawns the child before it returns, so everything after it
      // runs with a live process that only this scope still refers to. Throwing
      // out of here abandons the session before any caller owns it — the child
      // would keep running with nothing left to stop it.
      this.detachClient()
      try {
        await client.close()
      } catch (closeErr) {
        console.error(`[dsh][session] failed to stop the runtime after a failed start:`, closeErr)
      }
      throw err
    }
  }

  /**
   * Announce the end of the child process exactly once.
   *
   * Both a crash and a `close()` reach here, and a crash is normally followed
   * by a `close()` from the owner reacting to it. Announcing twice would run
   * `session-manager`'s teardown a second time, against whatever session has
   * since been registered under the same conversation.
   */
  private notifyExit(error?: Error): void {
    if (this.exitNotified) return
    this.exitNotified = true
    for (const cb of Array.from(this.exitListeners)) {
      try { cb(error) } catch { /* best-effort */ }
    }
  }

  private detachClient(): void {
    try { this.unsubscribe?.() } catch { /* best-effort */ }
    try { this.unsubscribeExit?.() } catch { /* best-effort */ }
    this.unsubscribe = null
    this.unsubscribeExit = null
    this.client = null
  }

  // --------------------------------------------------------------------------
  // V2SDKSession surface
  // --------------------------------------------------------------------------

  send(message: any): void {
    if (this.closed) throw new Error('dsh session is closed')
    this.queue.push({ contentBlocks: toContentBlocks(message) })
    this.dispatchQueued()
  }

  /**
   * One `stream()` call == one turn. Terminates as soon as it yields the
   * `result` frame so the consumer's outer loop can emit `agent:complete`.
   */
  async *stream(): AsyncIterable<any> {
    while (!this.closed || this.frameQueue.length > 0) {
      if (this.frameQueue.length === 0) {
        await new Promise<void>((resolve) => {
          this.frameWaiters.push(resolve)
          if (this.closed) resolve()
        })
        continue
      }
      const frame = this.frameQueue.shift()
      yield frame
      if (frame && frame.type === 'result') return
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const client = this.client
    this.detachClient()
    this.queue = []
    try { await client?.close() } catch { /* best-effort */ }
    // After the child, never before: it holds open connections to the bridge.
    try { await this.mcpBridge?.close() } catch { /* best-effort */ }
    this.notifyExit()
    this.wakeFrameWaiters()
  }

  /**
   * The harness protocol has no prompt-cancel method, so the only way to stop
   * an in-flight turn is to kill the runtime. That is a process restart, not
   * an interrupt: the session dies with the child, queued prompts are lost,
   * and the next user message builds a fresh session from scratch. Anything
   * gentler here would be a lie — the runtime would keep generating and keep
   * billing while the UI claimed it had stopped.
   *
   * A terminal `result` is emitted first so the consumer's current turn
   * settles instead of hanging on a stream that will never produce one.
   */
  async interrupt(): Promise<void> {
    if (this.closed) return
    this.pushFrames(this.normalizer.endTurn('Stopped — the dsh runtime has no cancel, so the session was closed.'))
    await this.close()
  }

  /**
   * Provider, model, and cwd are pinned for the life of the runtime process by
   * the `initialize` handshake, so a mid-session switch is not expressible.
   * Halo rebuilds the session on a model change, which is what actually
   * applies the new route.
   */
  async setModel(_model: string | undefined): Promise<void> {}

  async setMaxThinkingTokens(_maxThinkingTokens: number | null): Promise<void> {}

  /** No approval channel exists in either direction; every mode behaves alike. */
  async setPermissionMode(_mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'): Promise<void> {}

  // --------------------------------------------------------------------------
  // Turn interval
  // --------------------------------------------------------------------------

  private async dispatchNext(): Promise<void> {
    // Prompts are serialized: a second one sent while an interval is open
    // would put its receipt inside the first turn, and the two turns could no
    // longer be told apart. The harness queues it anyway once we do send it.
    // `dispatching` closes the window between `prompt()` being called and its
    // receipt id landing, during which the guards below still read as free.
    if (this.dispatching || this.turnOpen || this.awaitingReceiptFor !== null) return
    if (this.closed || !this.client) return
    const next = this.queue.shift()
    if (!next) return

    this.dispatching = true
    try {
      const receipt = await this.client.prompt(this.sessionId, next.contentBlocks)
      this.awaitingReceiptFor = receipt.messageId
    } finally {
      this.dispatching = false
      this.drainDispatchBuffer()
    }
  }

  /**
   * Replay what arrived before the receipt id was known. The runtime starts
   * working the moment it accepts a prompt, so its first notifications — the
   * receipt itself included — routinely overtake the `session/prompt`
   * response on the wire. Dropping them loses the event that opens the turn,
   * and the turn then never ends.
   */
  private drainDispatchBuffer(): void {
    if (this.pendingWhileDispatching.length === 0) return
    const buffered = this.pendingWhileDispatching
    this.pendingWhileDispatching = []
    for (const notification of buffered) this.onNotification(notification)
  }

  private onNotification(notification: DshNotification): void {
    if (this.closed) return

    if (this.dispatching) {
      this.pendingWhileDispatching.push(notification)
      return
    }

    if (this.awaitingReceiptFor !== null) {
      if (!isInboxReceipt(notification, this.sessionId, this.awaitingReceiptFor)) return
      this.awaitingReceiptFor = null
      this.turnOpen = true
      this.pushFrames(this.normalizer.beginTurn())
      return
    }
    if (!this.turnOpen) return

    this.pushFrames(this.normalizer.handle(notification))

    if (this.normalizer.isOwnIdle(notification)) {
      this.turnOpen = false
      this.pushFrames(this.normalizer.endTurn())
      this.dispatchQueued()
    }
  }

  /**
   * Send the next queued prompt, settling its turn if the runtime refuses it.
   *
   * A refused `session/prompt` never produces the receipt that opens a turn,
   * so without an explicit `init` + `result` here the consumer would wait on
   * `stream()` forever and the conversation would show as thinking.
   */
  private dispatchQueued(): void {
    void this.dispatchNext().catch((err) => {
      const reason = err instanceof Error ? err.message : String(err)
      console.error(`[dsh][session] prompt dispatch failed: ${reason}`)
      this.awaitingReceiptFor = null
      this.pushFrames([...this.normalizer.beginTurn(), ...this.normalizer.endTurn(reason)])
      this.dispatchQueued()
    })
  }

  private pushFrames(frames: any[]): void {
    if (frames.length === 0) return
    for (const frame of frames) this.frameQueue.push(frame)
    this.wakeFrameWaiters()
  }

  private wakeFrameWaiters(): void {
    const waiters = this.frameWaiters.splice(0)
    for (const waiter of waiters) waiter()
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Whether this notification is the durable enqueue receipt for `messageId`.
 * The receipt — not the `session/prompt` response — is what marks the moment
 * the runtime committed our prompt to the session log, which is where the
 * activity interval begins.
 */
function isInboxReceipt(notification: DshNotification, sessionId: string, messageId: string): boolean {
  if (notification.method !== 'session.event') return false
  const payload = notification.payload as { sessionId?: string; event?: { type?: string; data?: any } } | undefined
  if (payload?.sessionId !== sessionId) return false
  const event = payload?.event
  if (event?.type !== 'agent/inbox/spliced') return false
  const inserted = event.data?.inserted
  return Array.isArray(inserted) && inserted.some((message) => message?.id === messageId)
}

/** Raster types the SDK protocol admits inline. */
const PROMPT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * Project a Halo outbound message onto harness prompt blocks, in order.
 *
 * Images travel inline as base64; the runtime admits each into its attachment
 * store before the model sees it. Halo has already replaced them with a text
 * block when the model cannot read images (`prepareNonVisionImageFallback`).
 */
function toContentBlocks(message: any): unknown[] {
  if (typeof message === 'string') return [{ type: 'text', text: message }]
  const content = message?.message?.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return [{ type: 'text', text: JSON.stringify(message) }]

  const blocks: unknown[] = []
  for (const block of content) {
    if (block?.type === 'text' && block.text) {
      blocks.push({ type: 'text', text: block.text })
    } else if (
      block?.type === 'image'
      && block.source?.type === 'base64'
      && PROMPT_IMAGE_TYPES.has(block.source.media_type)
    ) {
      blocks.push({ type: 'image', data: block.source.data, mimeType: block.source.media_type })
    }
  }
  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }]
}
