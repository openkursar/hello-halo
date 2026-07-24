/**
 * AI Terminal - Context (session registry, main process)
 *
 * Registry of session PROXIES for the ptys living in the pty-host worker.
 * Lives at process scope, fully decoupled from any SDK session or UI window —
 * a terminal keeps running across model switches, session rebuilds, and canvas
 * open/close (design hard constraint).
 *
 * A single process-global context backs every caller — main chat and automation
 * (digital-human / app-chat) runs alike. Cross-space isolation is enforced at
 * the tool layer (sdk-mcp-server scopes lookups by spaceId), not by separate
 * registries, so ptys survive session rebuilds and stay visible in the UI.
 *
 * Division of labor with the worker: the worker owns the sessions (cap,
 * exited-retention pruning, buffers); this context mirrors their metadata for
 * synchronous reads, forwards worker events to the process event bus, and
 * applies main-only policy — shell resolution, AI-activity signaling, and
 * viewer-ack flow control.
 */

import { EventEmitter } from 'events'
import { resolveShell } from './shell'
import { TerminalSessionProxy } from './session-proxy'
import { TerminalFlowController } from './flow-control'
import {
  ptyHostNotify,
  ptyHostRequest,
  setPtyHostCrashHandler,
  setPtyHostEventHandler,
  shutdownPtyHost
} from './host'
import { emitTerminalData, emitTerminalLifecycle } from './events'
import type { PtyHostEvent } from '../../../shared/protocol/pty-host.protocol'
import type { CreateTerminalOptions, TerminalInfo } from '../../../shared/types/terminal'

export class TerminalContext extends EventEmitter {
  private sessions = new Map<string, TerminalSessionProxy>()
  /** Sessions the user killed: removed from the registry on the worker's exit event. */
  private killed = new Set<string>()
  private workDir: string
  readonly flow: TerminalFlowController

  constructor(workDir: string) {
    super()
    this.workDir = workDir
    this.flow = new TerminalFlowController(
      (sessionId) => ptyHostNotify({ type: 'pause', sessionId }),
      (sessionId) => ptyHostNotify({ type: 'resume', sessionId })
    )
    // The context is the process-global registry, so it is the sole sink for
    // worker events and the crash policy.
    setPtyHostEventHandler((event) => this.onHostEvent(event))
    setPtyHostCrashHandler(() => this.onHostCrashed())
  }

  setWorkDir(dir: string): void {
    this.workDir = dir
  }

  async create(opts: CreateTerminalOptions): Promise<TerminalSessionProxy> {
    // Shell policy is resolved HERE (main): the worker executes specs verbatim.
    const shell = resolveShell(opts.shell)
    const { info } = await ptyHostRequest({
      type: 'create',
      spec: {
        shell,
        cwd: opts.cwd ?? this.workDir,
        cols: opts.cols,
        rows: opts.rows,
        title: opts.title,
        owner: opts.owner,
        spaceId: opts.spaceId
      }
    })
    const session = new TerminalSessionProxy(info)
    this.sessions.set(session.id, session)
    this.emitLifecycle({ sessionId: session.id, type: 'created' as const, info: session.info })
    return session
  }

  get(id: string): TerminalSessionProxy | undefined {
    return this.sessions.get(id)
  }

  list(): TerminalInfo[] {
    return [...this.sessions.values()].map(s => s.info)
  }

  kill(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.kill()
    if (session.info.state === 'exited') {
      // Already dead — this is a removal; no further worker exit event will come.
      this.sessions.delete(id)
      this.flow.drop(id)
    } else {
      // Keep the proxy: the renderer store reconciles on the 'exited' lifecycle
      // event (SSOT), which only the worker's exit event may emit. The proxy is
      // removed there (or by onHostCrashed if the worker dies first).
      this.killed.add(id)
    }
    return true
  }

  /** Signal that the AI is (or is not) actively writing to a session. */
  markAiActivity(id: string, writing: boolean): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.emitLifecycle({ sessionId: id, type: 'ai-activity' as const, info: session.info, aiWriting: writing })
  }

  /**
   * Record that the AI operated a session through a terminal tool. Emits the
   * 'touched' lifecycle event once (the first time the worker-authoritative
   * flag flips) so the UI can update the session's close policy and tray
   * membership; later calls are no-ops. AI-created sessions are already
   * aiTouched, so this only matters for user-opened terminals the AI drives.
   * Fire-and-forget for callers: the tool path must not wait on bookkeeping.
   */
  markAiTouched(id: string): void {
    const session = this.sessions.get(id)
    if (!session || session.info.aiTouched) return
    void session.markAiTouched().then((flipped) => {
      if (!flipped) return
      this.emitLifecycle({ sessionId: id, type: 'touched' as const, info: session.info })
    }).catch(() => {
      // Session vanished mid-call (exit/evict race) — nothing to record.
    })
  }

  // ============================================
  // Worker events
  // ============================================

  private onHostEvent(event: PtyHostEvent): void {
    switch (event.type) {
      case 'data': {
        const session = this.sessions.get(event.sessionId)
        if (session) session.info.lastActivityAt = Date.now()
        this.flow.onData(event.sessionId, event.data.length)
        const payload = { sessionId: event.sessionId, data: event.data }
        this.emit('data', payload)
        emitTerminalData(payload)
        break
      }
      case 'exit': {
        const session = this.sessions.get(event.sessionId)
        this.flow.drop(event.sessionId)
        if (!session) {
          // Exit outran the create response (instantly-dying shell): the proxy
          // is not registered yet. Still emit, or the renderer store — which
          // reconciles exclusively on this event — would keep a zombie entry.
          this.emitLifecycle({ sessionId: event.sessionId, type: 'exited' as const, info: event.info })
          break
        }
        session.applyInfo(event.info)
        this.emitLifecycle({ sessionId: event.sessionId, type: 'exited' as const, info: session.info })
        // A user-killed session is not retained for replay (the worker freed
        // its buffers on the kill notification), so drop the proxy now.
        if (this.killed.delete(event.sessionId)) this.sessions.delete(event.sessionId)
        break
      }
      case 'evicted':
        // The worker pruned an exited session's retained buffers; drop the
        // proxy so list() stops reporting it (renderer removes it on refresh).
        this.sessions.delete(event.sessionId)
        this.killed.delete(event.sessionId)
        this.flow.drop(event.sessionId)
        break
    }
  }

  /**
   * The worker died: every pty died with it and nothing is revivable. Mark all
   * running sessions exited so the UI shows its ended banner; keep the proxies
   * so tabs don't vanish mid-crash (replay is gone — the viewer degrades to
   * "output no longer available"). The next create() forks a fresh worker.
   */
  private onHostCrashed(): void {
    console.error('[AI Terminal] Pty host crashed; marking all sessions exited')
    // Kills awaiting their exit event will never get one — the crash sweep
    // below emits their 'exited' lifecycle instead.
    this.killed.clear()
    for (const session of this.sessions.values()) {
      if (session.info.state !== 'running') continue
      session.info.state = 'exited'
      session.info.exitCode = null
      this.flow.drop(session.id)
      this.emitLifecycle({ sessionId: session.id, type: 'exited' as const, info: session.info })
    }
  }

  private emitLifecycle(event: {
    sessionId: string
    type: 'created' | 'exited' | 'title' | 'ai-activity' | 'touched'
    info?: TerminalInfo
    aiWriting?: boolean
  }): void {
    this.emit('lifecycle', event)
    emitTerminalLifecycle(event)
  }

  /** Destroy every session and the worker (context teardown). */
  destroy(): void {
    this.sessions.clear()
    this.killed.clear()
    void shutdownPtyHost()
    this.removeAllListeners()
  }
}

// Global singleton for the interactive main-chat terminal.
let globalContext: TerminalContext | null = null

export function getGlobalTerminalContext(workDir: string): TerminalContext {
  if (!globalContext) {
    globalContext = new TerminalContext(workDir)
  } else {
    globalContext.setWorkDir(workDir)
  }
  return globalContext
}

export function peekGlobalTerminalContext(): TerminalContext | null {
  return globalContext
}

/** Shutdown hook (bootstrap/extended.ts). */
export function cleanupAITerminal(): void {
  if (globalContext) {
    globalContext.destroy()
    globalContext = null
    console.log('[AI Terminal] Global context cleaned up')
  }
}
