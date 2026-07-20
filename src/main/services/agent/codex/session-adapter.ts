/**
 * Codex app-server session adapter.
 *
 * Bridges Halo's V2SDKSession contract (the Claude Code SDK shape) onto
 * a long-running `codex app-server` JSON-RPC connection. One adapter
 * instance == one Codex thread. Across the lifetime of a conversation, the
 * adapter:
 *
 *   - spawns the app-server child once (transport/connection.ts)
 *   - performs the JSON-RPC handshake (initialize / initialized)
 *   - starts or resumes a thread (thread/start or thread/resume)
 *   - dispatches user messages as turn/start
 *   - normalizes notifications into a CC-shaped event stream that Halo's
 *     stream-processor consumes verbatim
 *
 * The big change versus the old subprocess-per-turn adapter:
 *   - send() no longer spawns; it just enqueues a turn and notifies stream()
 *   - stream() is PER-TURN: each call yields one turn's events and returns
 *     when the turn's `result` frame is yielded. The consumer's outer loop
 *     re-enters stream() to pick up the next turn. This matches Halo's
 *     session-consumer contract (session-consumer.ts:13-15) that processes
 *     emit `agent:complete` between turns. Notification queue is instance
 *     state and persists across stream() calls, so nothing is lost.
 *   - interrupt() sends turn/interrupt; the app-server cancels the in-flight
 *     turn and the next turn can be queued normally
 *   - the `query.transport.{isReady, ready, onExit}` shim is now BACKED by
 *     the real child process, not faked
 */

import { randomUUID } from 'crypto'
import {
  createCodexConnection,
  resolveBundledCodexBinary,
  type CodexConnection,
} from './transport/connection'
import { JsonRpcClient } from './transport/jsonrpc-client'
import {
  registerServerRequestHandlers,
  type AskQuestionPayload,
  type AskQuestionAnswers,
} from './transport/server-request-handler'
import { CodexEventNormalizer } from './event-normalizer'
import { resolveCodexOptions, type CodexResolvedOptions } from './options'
import {
  ClientMethods,
  ServerNotifications,
  type InitializeParams,
  type InitializeResponse,
  type ThreadStartResponse,
  type TurnStartParams,
  type UserInput,
} from './types/codex-protocol'
import { emitAgentEvent } from '../events'
import { resolveQuestion } from '../permission-handler'

interface PendingTurn {
  input: UserInput[]
  /** Resolves once turn/start has been sent and a turnId is known. */
  ack: { resolve: () => void; reject: (err: Error) => void }
  abortController: AbortController
}

interface AdapterOptions {
  /** Optional spaceId/conversationId for AskUserQuestion event routing. */
  spaceId?: string
  conversationId?: string
  /** Optional thread id for resume (set by Halo when a conversation has prior history). */
  resume?: string
}

export class CodexAppServerSession {
  private connection: CodexConnection | null = null
  private rpc: JsonRpcClient | null = null
  private normalizer: CodexEventNormalizer
  private readonly sessionId: string
  private readonly options: CodexResolvedOptions
  private readonly opts: AdapterOptions
  private threadId: string | null = null
  private currentTurnId: string | null = null
  private closed = false
  private starting: Promise<void> | null = null
  private notificationQueue: any[] = []
  private notificationWaiters: Array<() => void> = []
  private queue: PendingTurn[] = []
  private exitListeners = new Set<(error?: Error) => void>()
  private pendingHaloQuestionIds = new Set<string>()
  private serverHandlerDisposer: (() => void) | null = null

  /**
   * Implements V2SDKSession.query — the CC SDK shape Halo's session-manager
   * and `ensureSessionWarm` consume:
   *
   *   - `query.transport.{isReady, ready, onExit}`:
   *     liveness probes used by session-manager polling + onExit cleanup.
   *     Backed by the real child process state.
   *
   *   - `query.supportedCommands()`:
   *     called by `ensureSessionWarm` to populate the slash-command palette
   *     without starting a turn. Codex has no slash commands, so this is a
   *     stable empty stub. Without the stub, ensureSessionWarm would log a
   *     `TypeError: query.supportedCommands is not a function` (caught,
   *     non-fatal) on every conversation switch.
   */
  readonly query: {
    transport: {
      isReady: () => boolean
      ready: boolean
      onExit?: (cb: (error?: Error) => void) => () => void
    }
    supportedCommands: () => Promise<unknown[]>
  }

  private constructor(options: CodexResolvedOptions, sessionId: string, opts: AdapterOptions) {
    this.sessionId = sessionId
    this.options = options
    this.opts = opts
    this.normalizer = new CodexEventNormalizer({
      sessionId,
      model: options.model,
      mcpServers: options.mcpServers,
      includePartialMessages: options.includePartialMessages,
    })

    const isReady = (): boolean =>
      !this.closed && this.connection !== null && this.connection.isAlive() && this.rpc !== null && this.rpc.isOpen()

    this.query = {
      transport: {
        isReady,
        get ready() { return isReady() },
        onExit: (cb) => {
          this.exitListeners.add(cb)
          return () => this.exitListeners.delete(cb)
        },
      },
      // Codex has no slash-command surface; return an empty list so
      // Halo's warmup path doesn't trip on a missing method.
      supportedCommands: async () => [],
    }
  }

  static async create(sdkOptions: Record<string, any>): Promise<CodexAppServerSession> {
    const options = await resolveCodexOptions(sdkOptions)
    const sessionId = (sdkOptions.resume as string | undefined) || randomUUID()
    const adapter = new CodexAppServerSession(options, sessionId, {
      spaceId: sdkOptions.spaceId,
      conversationId: sdkOptions.conversationId,
      resume: sdkOptions.resume,
    })
    await adapter.start()
    return adapter
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  private async start(): Promise<void> {
    if (this.starting) return this.starting
    this.starting = this.doStart()
    return this.starting
  }

  private async doStart(): Promise<void> {
    const resolvedBinary = resolveBundledCodexBinary()
    if (!resolvedBinary) {
      throw new Error(
        '[Codex] Could not find the codex binary. Make sure @openai/codex and its platform package are installed.',
      )
    }

    const connection = createCodexConnection({
      binaryPath: resolvedBinary.binaryPath,
      isJsShim: resolvedBinary.isJsShim,
      pathDirs: resolvedBinary.pathDirs,
      env: this.options.env,
      cwd: this.options.cwd,
      onStderr: (line) => {
        // Codex's stderr is structured Rust logs; surface as debug.
        if (process.env.HALO_CODEX_LOG_STDERR) {
          console.log(`[Codex][stderr] ${line}`)
        }
      },
    })
    this.connection = connection
    await connection.start()

    const rpc = new JsonRpcClient({
      stdin: connection.stdin,
      stdout: connection.stdout,
      onParseError: (raw, err) => {
        console.warn(`[Codex][rpc] parse error: ${err.message} | line=${raw.slice(0, 200)}`)
      },
      onClose: (reason) => {
        console.log(`[Codex][rpc] closed (${reason})`)
        this.handleConnectionExit(undefined)
      },
    })
    this.rpc = rpc

    connection.onExit((code, signal) => {
      const err = code === 0 ? undefined : new Error(`codex app-server exited code=${code} signal=${signal}`)
      this.handleConnectionExit(err)
    })

    // Wire the bidirectional server-request handlers (approvals + elicitation).
    this.serverHandlerDisposer = registerServerRequestHandlers(rpc, {
      conversationId: this.opts.conversationId || this.sessionId,
      askQuestion: (payload) => this.askQuestion(payload),
    })

    // Subscribe to streaming notifications. Each handler funnels into the
    // shared notificationQueue that stream() drains.
    this.subscribeNotifications(rpc)

    // Handshake.
    const initParams: InitializeParams = {
      clientInfo: { name: 'halo', version: process.env.npm_package_version || '0.0.0' },
      capabilities: { experimentalApi: true },
    }
    const initResult = await rpc.request<InitializeResponse>(ClientMethods.Initialize, initParams)
    console.log(`[Codex][session] initialized: codexHome=${initResult?.codexHome} platform=${initResult?.platformOs}`)
    rpc.notify(ClientMethods.Initialized, {})

    // Start (or resume) the thread.
    const threadStartParams = { ...this.options.threadParams }
    let response: ThreadStartResponse
    if (this.opts.resume) {
      response = await rpc.request<ThreadStartResponse>(ClientMethods.ThreadResume, {
        ...threadStartParams,
        id: this.opts.resume,
      })
    } else {
      response = await rpc.request<ThreadStartResponse>(ClientMethods.ThreadStart, threadStartParams)
    }
    this.threadId = response?.thread?.id ?? null
    if (!this.threadId) {
      throw new Error('[Codex] thread/start did not return a thread id')
    }

    // Tag the normalizer with the real thread id so any lazy `system.init`
    // emitted later carries the persistable id rather than our
    // pre-handshake random UUID. This keeps session resume working: Halo
    // persists `system.init.session_id` as `conversation.sessionId`, which
    // we replay as `thread/resume.id`.
    this.normalizer.setSessionId(this.threadId)

    // DO NOT push system:init here. Per the Claude Code SDK contract,
    // `system:init` is a per-TURN event (the first frame of a streaming
    // turn), not a session-lifecycle event. Halo's stream-processor reads
    // an init message as "a new turn started" and flips chat.store into
    // isStreaming=true; with no result frame to follow on warmup, the UI
    // freezes in the "thinking…" state forever and the user (rationally) presses Stop,
    // putting the consumer into silent-drain mode and breaking the next
    // real send.
    //
    // Init is emitted lazily by the normalizer's handleTurnStarted /
    // handleItemStarted on the first notification AFTER the user sends
    // their first message — exactly the moment a turn actually begins,
    // matching CC's behavior. Halo's `ensureSessionWarm` independently
    // surfaces session metadata via `agent:session-info`, so the UI is
    // not deprived of slash-command / model info during warmup.
  }

  private subscribeNotifications(rpc: JsonRpcClient): void {
    const reflect = (method: string) => (params: unknown) => {
      try {
        for (const msg of this.normalizer.handle(method, params)) {
          this.pushNotification(msg)
        }
      } catch (err) {
        console.error(`[Codex][session] normalizer threw on "${method}":`, err)
      }
    }

    rpc.onNotification(ServerNotifications.ThreadStarted, reflect(ServerNotifications.ThreadStarted))
    rpc.onNotification(ServerNotifications.TurnStarted, (params) => {
      // Track current turnId for interrupt routing.
      const tp = params as { turnId?: string } | undefined
      if (tp?.turnId) this.currentTurnId = tp.turnId
      reflect(ServerNotifications.TurnStarted)(params)
    })
    rpc.onNotification(ServerNotifications.ItemStarted, reflect(ServerNotifications.ItemStarted))
    rpc.onNotification(ServerNotifications.ItemUpdated, reflect(ServerNotifications.ItemUpdated))
    rpc.onNotification(ServerNotifications.ItemCompleted, reflect(ServerNotifications.ItemCompleted))
    rpc.onNotification(ServerNotifications.AgentMessageDelta, reflect(ServerNotifications.AgentMessageDelta))
    rpc.onNotification(ServerNotifications.ReasoningTextDelta, reflect(ServerNotifications.ReasoningTextDelta))
    rpc.onNotification(ServerNotifications.ReasoningSummaryTextDelta, reflect(ServerNotifications.ReasoningSummaryTextDelta))
    rpc.onNotification(ServerNotifications.CommandExecutionOutputDelta, reflect(ServerNotifications.CommandExecutionOutputDelta))
    rpc.onNotification(ServerNotifications.ThreadTokenUsageUpdated, reflect(ServerNotifications.ThreadTokenUsageUpdated))
    rpc.onNotification(ServerNotifications.ThreadCompacted, reflect(ServerNotifications.ThreadCompacted))
    rpc.onNotification(ServerNotifications.TurnCompleted, (params) => {
      reflect(ServerNotifications.TurnCompleted)(params)
      this.currentTurnId = null
    })
    rpc.onNotification(ServerNotifications.TurnFailed, (params) => {
      reflect(ServerNotifications.TurnFailed)(params)
      this.currentTurnId = null
    })
    rpc.onNotification(ServerNotifications.Error, reflect(ServerNotifications.Error))
    rpc.onNotification(ServerNotifications.Warning, reflect(ServerNotifications.Warning))
  }

  // --------------------------------------------------------------------------
  // V2SDKSession surface
  // --------------------------------------------------------------------------

  send(message: any): void {
    if (this.closed) throw new Error('Codex session is closed')
    const input = normalizeMessageInput(message)
    const turn: PendingTurn = {
      input,
      ack: { resolve: () => {}, reject: () => {} },
      abortController: new AbortController(),
    }
    this.queue.push(turn)
    void this.dispatchNextTurn().catch((err) => {
      console.error(`[Codex][session] dispatch failed:`, err)
      this.pushNotification(this.normalizer.createResult(true, err instanceof Error ? err.message : String(err)))
    })
  }

  /**
   * One stream() call == one turn, per Halo's session-consumer contract:
   *
   *   "Each stream() call yields events for one CC turn and completes when
   *   CC produces a `result`. The loop then re-enters stream() to wait for
   *   the next turn."   — session-consumer.ts:13-15
   *
   * Halo's `stream-processor.processStream` consumes via `for await`. That
   * loop only exits when this iterator returns. The consumer's outer
   * `while` then emits `agent:complete`, which the renderer reads as
   * "turn finished, stop showing the thinking indicator". If we yield-and-loop forever,
   * processStream never returns, agent:complete never fires, and the UI
   * stays in thinking state forever even though the result event was
   * pushed.
   *
   * We therefore TERMINATE the iterator as soon as we yield a frame whose
   * `type === 'result'`. The notification queue is instance state, so the
   * next `stream()` invocation picks up any leftover frames and waits for
   * new ones; nothing is lost across turns.
   */
  async *stream(): AsyncIterable<any> {
    while (!this.closed || this.notificationQueue.length > 0) {
      if (this.notificationQueue.length === 0) {
        await new Promise<void>((resolve) => {
          this.notificationWaiters.push(resolve)
          if (this.closed) resolve()
        })
        continue
      }
      const next = this.notificationQueue.shift()
      yield next
      // Terminal frame closes the per-turn iterator. The consumer's outer
      // loop re-enters stream() to await / drain the next turn.
      if (next && next.type === 'result') return
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true

    // Reject any AskUserQuestion bridges waiting on user input.
    for (const id of this.pendingHaloQuestionIds) {
      try { resolveQuestion(id, {}) } catch { /* best-effort */ }
    }
    this.pendingHaloQuestionIds.clear()

    // Drain any in-flight turns.
    for (const turn of this.queue) turn.abortController.abort()
    this.queue = []

    try { this.serverHandlerDisposer?.() } catch { /* best-effort */ }
    this.serverHandlerDisposer = null

    try { this.rpc?.close('shutdown') } catch { /* best-effort */ }
    this.rpc = null

    try { await this.connection?.stop() } catch { /* best-effort */ }
    this.connection = null

    try { await this.options.mcpBridge?.close() } catch { /* best-effort */ }

    // Wake any pending stream() consumer so they observe end-of-stream.
    this.wakeNotificationWaiters()
  }

  async interrupt(): Promise<void> {
    if (!this.rpc || !this.threadId) return
    if (!this.currentTurnId) return
    try {
      await this.rpc.request(ClientMethods.TurnInterrupt, {
        threadId: this.threadId,
        turnId: this.currentTurnId,
      })
    } catch (err) {
      // The server may already have completed the turn — log and proceed.
      console.warn(`[Codex][session] turn/interrupt failed: ${(err as Error).message}`)
    }
  }

  async setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void> {
    this.options.threadParams.config = {
      ...(this.options.threadParams.config || {}),
      model_reasoning_effort: maxThinkingTokens ? 'high' : 'medium',
    }
  }

  async setPermissionMode(mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'): Promise<void> {
    this.options.threadParams.approvalPolicy = mode === 'bypassPermissions' ? 'never' : 'on-request'
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private async dispatchNextTurn(): Promise<void> {
    if (!this.rpc || !this.threadId) return
    if (this.queue.length === 0) return
    const turn = this.queue.shift()!

    // Reset per-turn state in the normalizer; the message_start envelope is
    // emitted on the first item/started or by turn/started.
    this.normalizer.resetTurn()

    const params: TurnStartParams = {
      threadId: this.threadId,
      input: turn.input,
    }
    try {
      await this.rpc.request(ClientMethods.TurnStart, params)
    } catch (err) {
      // The server rejected turn/start outright (rare) — surface as a result.
      const message = err instanceof Error ? err.message : String(err)
      this.pushNotification(this.normalizer.createResult(true, message))
    }

    // The actual turn lifetime is driven by streaming notifications, not by
    // the RPC return value. We fire-and-forget here; the next user message
    // will queue another turn after the current one completes.
  }

  private pushNotification(msg: any): void {
    this.notificationQueue.push(msg)
    this.wakeNotificationWaiters()
  }

  private wakeNotificationWaiters(): void {
    const waiters = this.notificationWaiters.splice(0)
    for (const w of waiters) w()
  }

  private handleConnectionExit(err: Error | undefined): void {
    if (this.closed) return
    // Surface a synthetic terminal error so the consumer's current turn
    // doesn't hang; the session-manager will tear down on the next health
    // poll (transport.isReady → false) and the next user message will
    // create a fresh session.
    if (this.notificationQueue.length === 0 || !this.normalizer.isTerminal()) {
      this.pushNotification(this.normalizer.createResult(true, err?.message || 'Codex app-server exited'))
    }
    this.closed = true
    void this.options.mcpBridge?.close().catch(() => {})
    for (const cb of this.exitListeners) {
      try { cb(err) } catch { /* best-effort */ }
    }
    this.wakeNotificationWaiters()
  }

  // --------------------------------------------------------------------------
  // AskUserQuestion bridge
  // --------------------------------------------------------------------------

  private askQuestion(payload: AskQuestionPayload): Promise<AskQuestionAnswers> {
    if (!this.opts.spaceId || !this.opts.conversationId) {
      // No conversation context — auto-deny by returning empty answers (the
      // server-request handler will translate this to "Cancel" / reject).
      return Promise.resolve({})
    }
    const id = `codex-ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return new Promise<AskQuestionAnswers>((resolve, reject) => {
      // Register with permission-handler so the existing IPC path
      // (`agent:answer-question` → resolveQuestion) routes user answers back
      // to us. Bypass the strict CC `tool_use` callback flow — we are an
      // independent question source.
      const wrapped = {
        resolve: (answers: Record<string, string>) => {
          this.pendingHaloQuestionIds.delete(id)
          resolve(answers)
        },
        reject: (err: unknown) => {
          this.pendingHaloQuestionIds.delete(id)
          reject(err instanceof Error ? err : new Error(String(err)))
        },
      }
      registerCodexPendingQuestion(id, wrapped)
      this.pendingHaloQuestionIds.add(id)

      emitAgentEvent('agent:ask-question', this.opts.spaceId!, this.opts.conversationId!, {
        id,
        questions: payload.questions,
      })
    })
  }
}

// ============================================================================
// Helpers
// ============================================================================

function normalizeMessageInput(message: any): UserInput[] {
  if (typeof message === 'string') {
    return [{ type: 'text', text: message }]
  }
  const content = message?.message?.content
  if (Array.isArray(content)) {
    const inputs: UserInput[] = []
    const textParts: string[] = []
    for (const block of content) {
      if (block?.type === 'text') textParts.push(block.text || '')
      if (block?.type === 'image' && block.source?.type === 'base64') {
        const path = block.source.path || block.path
        if (path) inputs.push({ type: 'localImage', path })
      }
    }
    if (textParts.length > 0) inputs.unshift({ type: 'text', text: textParts.join('\n\n') })
    return inputs.length > 0 ? inputs : [{ type: 'text', text: '' }]
  }
  return [{ type: 'text', text: typeof message === 'string' ? message : JSON.stringify(message) }]
}

// ============================================================================
// External pending-question registration
// ============================================================================

/**
 * Map of Codex-issued AskUserQuestion ids → pending resolvers. Separate from
 * `permission-handler.pendingQuestions` because that map is module-private,
 * and our requests aren't gated by a CC `canUseTool` callback.
 *
 * The IPC handler `agent:answer-question` calls `resolveCodexPendingQuestion`
 * (re-exported via permission-handler integration below) when a user submits.
 */
const codexPendingQuestions = new Map<string, {
  resolve: (answers: Record<string, string>) => void
  reject: (err: unknown) => void
}>()

function registerCodexPendingQuestion(
  id: string,
  entry: {
    resolve: (answers: Record<string, string>) => void
    reject: (err: unknown) => void
  },
): void {
  codexPendingQuestions.set(id, entry)
}

/**
 * Try to resolve a Codex-bridged pending question. Returns `true` if a
 * matching question was found and resolved. The IPC layer should call this
 * BEFORE falling back to permission-handler.resolveQuestion so Codex
 * elicitations don't get crossed with CC AskUserQuestion calls.
 */
export function resolveCodexPendingQuestion(id: string, answers: Record<string, string>): boolean {
  const entry = codexPendingQuestions.get(id)
  if (!entry) return false
  codexPendingQuestions.delete(id)
  entry.resolve(answers)
  return true
}

/** Reject all outstanding Codex questions (e.g. on session close). */
export function rejectAllCodexPendingQuestions(reason = 'Session closed'): void {
  for (const [id, entry] of Array.from(codexPendingQuestions.entries())) {
    try { entry.reject(new Error(reason)) } catch { /* ignore */ }
    codexPendingQuestions.delete(id)
  }
}
