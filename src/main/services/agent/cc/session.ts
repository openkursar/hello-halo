import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import type { CcRuntimeLaunch } from '../../cc-runtime'
import type { SessionLiveInputOptions } from '../types'
import { hostSystemPromptText } from '../system-prompt'
import type { SdkMcpBridge } from '../mcp/sdk-bridge'
import { buildCcArguments, prepareMcpServers, type CcOptions } from './options'

interface PendingControl {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface Input {
  message: any
  live?: SessionLiveInputOptions
  written: boolean
}

const CONTROL_TIMEOUT_MS = 30_000
const CANCEL_TIMEOUT_MS = 2_000

/** One native stream-json process; stream() ends at each result, not at process exit. */
export class CcSession {
  private child: ChildProcessWithoutNullStreams | null = null
  private bridge?: SdkMcpBridge
  private closed = false
  private ended = false
  private failure?: Error
  private nativeSessionId?: string
  private frames: any[] = []
  private lines?: ReturnType<typeof createInterface>
  private waiters: Array<() => void> = []
  private controls = new Map<string, PendingControl>()
  private callbacks = new Map<string, (...args: any[]) => Promise<any>>()
  private callbackAbort = new Map<string, AbortController>()
  private pending = new Map<string, Input>()
  private pendingAtResult = new Set<string>()
  private inputs: Input[] = []
  private writing = false
  private heartbeat?: ReturnType<typeof setInterval>
  private killTimer?: ReturnType<typeof setTimeout>
  private forceKillTimer?: ReturnType<typeof setTimeout>
  private frameCount = 0
  private readonly exitListeners = new Set<(error?: Error) => void>()
  private initialization: Promise<any>
  private exitPromise: Promise<void> = Promise.resolve()
  private bridgeClosing?: Promise<void>
  readonly query: {
    transport: { isReady: () => boolean; close: () => void; process?: ChildProcessWithoutNullStreams; onExit: (listener: (error?: Error) => void) => () => void }
    supportedCommands: () => Promise<any[]>
    supportedModels: () => Promise<any[]>
    initializationResult: () => Promise<any>
    cancelAsyncMessage: (uuid: string) => Promise<boolean>
  }

  constructor(private readonly options: CcOptions, private readonly launch: CcRuntimeLaunch) {
    this.query = {
      transport: {
        isReady: () => !!this.child && !this.closed && !this.ended && !this.failure,
        close: () => this.close(),
        onExit: listener => {
          if (this.ended) listener(this.failure)
          else this.exitListeners.add(listener)
          return () => { this.exitListeners.delete(listener) }
        },
      },
      supportedCommands: async () => (await this.initialization).commands ?? [],
      supportedModels: async () => (await this.initialization).models ?? [],
      initializationResult: () => this.initialization,
      cancelAsyncMessage: async uuid => (await this.request({ subtype: 'cancel_async_message', message_uuid: uuid })).cancelled === true,
    }
    this.initialization = this.initialize()
    // Startup errors are observed by createSession/send/stream, even with no consumer yet.
    void this.initialization.catch(error => this.fail(error))
  }

  get sessionId(): string | undefined { return this.nativeSessionId }
  get pid(): number | null { return this.child?.pid ?? null }

  private async initialize(): Promise<any> {
    const mcp = await prepareMcpServers(this.options)
    this.bridge = mcp.bridge
    if (this.closed) { await this.closeBridge(); throw new Error('CC session closed during initialization') }
    const env = Object.fromEntries(Object.entries({ ...this.options.env, ...this.launch.env })
      .filter(([, value]) => value != null).map(([key, value]) => [key, String(value)]))
    env.DISABLE_AUTOUPDATER = '1'
    delete env.NODE_OPTIONS
    if (this.launch.kind === 'native') delete env.ELECTRON_RUN_AS_NODE
    // The entry point must match Halo's delegated authentication flow, not the SDK package.
    env.CLAUDE_CODE_ENTRYPOINT ??= 'cli'
    const args = [...this.launch.argsPrefix, ...buildCcArguments(this.options, mcp.servers)]
    this.child = spawn(this.launch.command, args, { cwd: this.options.cwd, env, windowsHide: true, stdio: 'pipe' })
    const child = this.child
    this.query.transport.process = child
    this.exitPromise = new Promise(resolve => {
      child.once('close', (code, signal) => {
        this.ended = true
        clearTimeout(this.killTimer)
        clearTimeout(this.forceKillTimer)
        clearInterval(this.heartbeat)
        if (!this.closed) this.fail(new Error(`CC process exited before session close (code=${code}, signal=${signal ?? 'none'})`))
        this.rejectControls(new Error('CC process exited'))
        for (const controller of this.callbackAbort.values()) controller.abort()
        this.callbackAbort.clear()
        this.wake()
        for (const listener of this.exitListeners) {
          try { listener(this.failure) }
          catch (error) { console.error(`[CC] Session exit listener failed pid=${child.pid}:`, error) }
        }
        this.exitListeners.clear()
        void this.closeBridge()
        console.log(`[CC] Session exited pid=${child.pid ?? 'none'} code=${code} signal=${signal ?? 'none'} frames=${this.frameCount}`)
        resolve()
      })
    })
    child.once('error', error => this.fail(error))
    child.stdin.on('error', error => { if (!this.closed) this.fail(error) })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (data: string) => this.options.stderr?.(data))
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.lines.on('line', line => this.receive(line))
    this.heartbeat = setInterval(() => {
      console.log(`[CC] Session state pid=${child.pid ?? 'none'} session=${this.nativeSessionId ?? 'initializing'} frames=${this.frameCount} buffered=${this.frames.length} controls=${this.controls.size} unread=${this.pending.size}`)
    }, 120_000)
    this.heartbeat.unref()
    const hooks: Record<string, unknown[]> = {}
    let callbackId = 0
    for (const [event, matchers] of Object.entries(this.options.hooks ?? {}) as Array<[string, any[]]>) {
      hooks[event] = matchers.map(matcher => ({
        matcher: matcher.matcher,
        timeout: matcher.timeout,
        hookCallbackIds: matcher.hooks.map((callback: (...args: any[]) => Promise<any>) => {
          const id = `hook_${callbackId++}`
          this.callbacks.set(id, callback)
          return id
        }),
      }))
    }
    const prompt = this.options.systemPrompt
    const text = hostSystemPromptText(prompt)
    const systemPrompt = typeof prompt === 'string' ? text : undefined
    const appendSystemPrompt = typeof prompt === 'object' ? text : undefined
    const result = await this.request({
      subtype: 'initialize', hooks,
      systemPrompt, appendSystemPrompt,
      agents: this.options.agents,
      jsonSchema: this.options.outputFormat?.schema,
    })
    if (this.options.abortController?.signal.aborted) this.close()
    else this.options.abortController?.signal.addEventListener('abort', this.onAbort, { once: true })
    console.log(`[CC] Session ready pid=${child.pid ?? 'none'} runtime=${this.launch.kind} version=${this.launch.version} mcp=${Object.keys(mcp.servers).length}`)
    return result
  }

  private readonly onAbort = () => this.close()

  async ready(): Promise<void> { await this.initialization }

  async send(message: any): Promise<void> {
    await this.initialization
    if (this.closed || this.ended || this.failure) throw this.failure ?? new Error('CC session is closed')
    this.enqueue(message)
  }

  sendIntoLiveTurn(message: any, live?: SessionLiveInputOptions): boolean {
    if (!this.query.transport.isReady()) return false
    this.enqueue(message, live ?? {})
    return true
  }

  hasPendingInput(): boolean { return this.pending.size > 0 }

  private enqueue(message: any, live?: SessionLiveInputOptions): void {
    const frame = typeof message === 'string'
      ? { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: message }] } }
      : { ...message }
    if (live) frame.uuid ??= randomUUID()
    const input: Input = { message: frame, live, written: false }
    if (live) this.pending.set(frame.uuid, input)
    this.inputs.push(input)
    this.writeInputs()
  }

  private writeInputs(): void {
    if (this.writing || this.closed || this.failure) return
    const input = this.inputs.shift()
    if (!input) return
    this.writing = true
    input.written = true
    void this.write(input.message).then(() => {
      this.writing = false
      this.writeInputs()
    }, error => {
      this.writing = false
      this.fail(error)
    })
  }

  async withdrawUnreadInput(): Promise<number> {
    const entries = [...this.pending.entries()]
    const withdrawn = new Set<string>()
    let collecting = true
    const acknowledge = (uuid: string, input: Input) => {
      if (!this.pending.delete(uuid)) return
      this.pendingAtResult.delete(uuid)
      withdrawn.add(uuid)
      if (!collecting) this.notifyWithdrawn(input)
    }
    try {
      const unsent = new Set(entries.filter(([, input]) => !input.written).map(([, input]) => input))
      this.inputs = this.inputs.filter(input => !unsent.has(input))
      for (const [uuid, input] of entries) if (unsent.has(input)) acknowledge(uuid, input)
      const errors: Error[] = []
      await Promise.all(entries.filter(([, input]) => input.written).map(async ([uuid, input]) => {
        if (!this.pending.has(uuid)) return
        if (!this.query.transport.isReady()) { acknowledge(uuid, input); return }
        const cancel = this.query.cancelAsyncMessage(uuid)
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const cancelled = await Promise.race([cancel, new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`cancel_async_message got no answer within ${CANCEL_TIMEOUT_MS}ms`)), CANCEL_TIMEOUT_MS)
          })])
          if (cancelled) acknowledge(uuid, input)
        } catch (error) {
          if (!this.query.transport.isReady()) acknowledge(uuid, input)
          else {
            errors.push(error as Error)
            void cancel.then(cancelled => { if (cancelled) acknowledge(uuid, input) }, () => {
              if (!this.query.transport.isReady()) acknowledge(uuid, input)
            })
          }
        } finally { clearTimeout(timer) }
      }))
      if (errors.length) {
        console.warn(`[CC] Live input cancellation uncertain pid=${this.pid} count=${errors.length} reason=${errors[0].message}`)
        throw new Error(`cancel_async_message failed for ${errors.length} input(s), which may still run: ${errors[0].message}`)
      }
      return withdrawn.size
    } finally {
      collecting = false
      for (const [uuid, input] of entries) if (withdrawn.has(uuid)) this.notifyWithdrawn(input)
    }
  }

  private notifyWithdrawn(input: Input): void {
    try { input.live?.onWithdrawn?.() }
    catch (error) { console.error(`[CC] Withdrawn-input handler failed pid=${this.pid}:`, error) }
  }

  async *stream(): AsyncIterable<any> {
    await this.initialization
    while (true) {
      if (!this.frames.length) {
        if (this.failure) throw this.failure
        if (this.closed || this.ended) return
        await new Promise<void>(resolve => this.waiters.push(resolve))
        continue
      }
      const frame = this.frames.shift()
      if (this.frames.length < 128) this.lines?.resume()
      if (frame.type === 'user' && frame.isReplay) {
        if (frame.uuid) this.pending.delete(frame.uuid)
        const content = frame.message?.content
        const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('\n') : ''
        if (!text.includes('<local-command-stdout>') && !content?.some?.((block: any) => block.type === 'tool_result')) continue
      }
      if (frame.type === 'system' && frame.subtype === 'init') this.nativeSessionId = frame.session_id
      if (frame.type === 'result') {
        for (const uuid of this.pendingAtResult) this.pending.delete(uuid)
        this.pendingAtResult = new Set(this.pending.keys())
      }
      yield frame
      if (frame.type === 'result') return
    }
  }

  interrupt(): Promise<void> { return this.request({ subtype: 'interrupt' }) }
  setModel(model: string): Promise<void> { return this.request({ subtype: 'set_model', model }) }
  setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void> {
    return this.request({ subtype: 'set_max_thinking_tokens', max_thinking_tokens: maxThinkingTokens })
  }
  setPermissionMode(mode: string): Promise<void> { return this.request({ subtype: 'set_permission_mode', mode }) }
  async mcpServerStatus(): Promise<any[]> { return (await this.request({ subtype: 'mcp_status' })).mcpServers ?? [] }

  private receive(line: string): void {
    if (!line.trim() || this.closed) return
    try {
      // Native replay includes our own callback responses, which can contain very large tool results.
      if (line.startsWith('{"type":"control_response"')) {
        const id = /"request_id":"([^"\\]+)"/.exec(line)?.[1]
        if (id && !this.controls.has(id)) return
      }
      let frame: any
      if (line.startsWith('{"type":"user"') && /"isReplay":true[},]/.test(line)
        && !line.includes('<local-command-stdout>') && !line.includes('"type":"tool_result"')) {
        const uuid = /"uuid":"([a-zA-Z0-9-]+)"/.exec(line)?.[1]
        if (uuid) frame = { type: 'user', isReplay: true, uuid }
      }
      frame ??= JSON.parse(line)
      this.frameCount++
      if (frame.type === 'control_response') {
        const response = frame.response
        const pending = this.controls.get(response?.request_id)
        if (!pending) return
        this.controls.delete(response.request_id)
        clearTimeout(pending.timer)
        if (response.subtype === 'success') pending.resolve(response.response ?? {})
        else pending.reject(new Error(response.error ?? 'CC control request failed'))
        return
      }
      if (frame.type === 'control_request') { void this.answerControl(frame); return }
      if (frame.type === 'control_cancel_request') { this.callbackAbort.get(frame.request_id)?.abort(); return }
      if (frame.type === 'keep_alive' || frame.type === 'streamlined_text' || frame.type === 'streamlined_tool_use_summary'
        || (frame.type === 'system' && frame.subtype === 'post_turn_summary')) return
      this.frames.push(frame)
      if (this.frames.length >= 256) this.lines?.pause()
      this.wake()
    } catch (error) {
      this.fail(new Error(`Invalid CC stream-json frame (${line.length} bytes, ${(error as Error).name})`))
    }
  }

  private async answerControl(frame: any): Promise<void> {
    const controller = new AbortController()
    this.callbackAbort.set(frame.request_id, controller)
    const request = frame.request
    try {
      let response: any
      if (request.subtype === 'can_use_tool') {
        if (!this.options.canUseTool) throw new Error('No permission handler is configured')
        response = { ...await this.options.canUseTool(request.tool_name, request.input, {
          signal: controller.signal, suggestions: request.permission_suggestions,
          blockedPath: request.blocked_path, decisionReason: request.decision_reason,
          title: request.title, displayName: request.display_name, description: request.description,
          toolUseID: request.tool_use_id, agentID: request.agent_id,
        }), toolUseID: request.tool_use_id }
      } else if (request.subtype === 'hook_callback') {
        const callback = this.callbacks.get(request.callback_id)
        if (!callback) throw new Error(`Unknown hook callback: ${request.callback_id}`)
        response = await callback(request.input, request.tool_use_id, { signal: controller.signal })
      } else if (request.subtype === 'elicitation') {
        response = this.options.onElicitation ? await this.options.onElicitation({
          serverName: request.mcp_server_name, message: request.message, mode: request.mode,
          url: request.url, elicitationId: request.elicitation_id, requestedSchema: request.requested_schema,
        }, { signal: controller.signal }) : { action: 'decline' }
      } else throw new Error(`Unsupported CC control request: ${request.subtype}`)
      if (!this.closed && !controller.signal.aborted) await this.write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response } })
    } catch (error) {
      if (this.closed || controller.signal.aborted) return
      console.warn(`[CC] Host callback failed pid=${this.pid} subtype=${request.subtype}:`, error)
      try { await this.write({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: (error as Error).message } }) }
      catch (writeError) { this.fail(writeError) }
    } finally { this.callbackAbort.delete(frame.request_id) }
  }

  private request(request: Record<string, unknown>): Promise<any> {
    if (this.closed || this.ended || this.failure) return Promise.reject(this.failure ?? new Error('CC session is closed'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controls.delete(id)
        console.warn(`[CC] Control request timed out pid=${this.pid} subtype=${request.subtype}`)
        reject(new Error(`CC ${request.subtype} request timed out`))
      }, CONTROL_TIMEOUT_MS)
      timer.unref()
      this.controls.set(id, { resolve, reject, timer })
      void this.write({ type: 'control_request', request_id: id, request }).catch(error => {
        const pending = this.controls.get(id)
        if (!pending) return
        this.controls.delete(id)
        clearTimeout(pending.timer)
        pending.reject(error)
      })
    })
  }

  private write(frame: unknown): Promise<void> {
    if (!this.child || this.closed || this.ended) return Promise.reject(new Error('CC process is not writable'))
    return new Promise((resolve, reject) => this.child!.stdin.write(`${JSON.stringify(frame)}\n`, error => error ? reject(error) : resolve()))
  }

  private wake(): void { for (const resolve of this.waiters.splice(0)) resolve() }

  private rejectControls(error: Error): void {
    for (const pending of this.controls.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.controls.clear()
  }

  private fail(error: unknown): void {
    if (this.failure || this.closed) return
    this.failure = error instanceof Error ? error : new Error(String(error))
    console.error(`[CC] Session failed pid=${this.pid} session=${this.nativeSessionId ?? 'initializing'}:`, this.failure)
    this.rejectControls(this.failure)
    this.close()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.options.abortController?.signal.removeEventListener('abort', this.onAbort)
    clearInterval(this.heartbeat)
    this.inputs = []
    this.pending.clear()
    this.rejectControls(new Error('CC session closed'))
    for (const controller of this.callbackAbort.values()) controller.abort()
    this.callbackAbort.clear()
    this.callbacks.clear()
    if (this.child && !this.ended) {
      this.child.stdin.end()
      this.killTimer = setTimeout(() => this.child?.kill('SIGTERM'), 500)
      this.forceKillTimer = setTimeout(() => {
        if (!this.ended) {
          console.warn(`[CC] Session shutdown forced pid=${this.pid}`)
          this.child?.kill('SIGKILL')
        }
      }, 2500)
      this.killTimer.unref()
      this.forceKillTimer.unref()
    }
    void this.closeBridge()
    this.wake()
  }

  private closeBridge(): Promise<void> {
    if (!this.bridge) return Promise.resolve()
    this.bridgeClosing ??= this.bridge.close().catch(error => {
      console.error(`[CC] MCP bridge close failed pid=${this.pid}:`, error)
    })
    return this.bridgeClosing
  }

  async flush(): Promise<void> {
    await this.initialization.catch(() => undefined)
    await this.exitPromise
    await this.closeBridge()
  }
}
