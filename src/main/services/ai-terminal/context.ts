/**
 * AI Terminal - Context (session registry)
 *
 * Owns the live pty sessions. Lives at process scope, fully decoupled from any
 * SDK session or UI window — a terminal keeps running across model switches,
 * session rebuilds, and canvas open/close (design hard constraint).
 *
 * A global singleton backs the main chat; scoped contexts isolate automation
 * (digital-human / app-chat) runs, mirroring ai-browser's context model.
 */

import { EventEmitter } from 'events'
import { TerminalSession } from './session'
import { emitTerminalData, emitTerminalLifecycle } from './events'
import type { CreateTerminalOptions, TerminalInfo } from './types'

/** Hard cap on concurrent sessions per context (guards runaway spawning) */
const MAX_SESSIONS = 12

/**
 * How many exited sessions to keep for read-only replay before evicting the
 * oldest. An exited pty holds no process, but its @xterm/headless screen buffer
 * (up to the scrollback cap) and replay buffer stay resident until kill() runs,
 * so unbounded retention leaks memory across a long-lived session.
 */
const MAX_EXITED_RETAINED = 8

export class TerminalContext extends EventEmitter {
  private sessions = new Map<string, TerminalSession>()
  private workDir: string
  /** When true, forward events to the global bus (main-chat UI). */
  private global: boolean

  constructor(workDir: string, global = false) {
    super()
    this.workDir = workDir
    this.global = global
  }

  setWorkDir(dir: string): void {
    this.workDir = dir
  }

  create(opts: CreateTerminalOptions): TerminalSession {
    if (this.liveCount() >= MAX_SESSIONS) {
      throw new Error(`Terminal session limit reached (${MAX_SESSIONS}). Close a session first.`)
    }
    const session = new TerminalSession(opts, opts.cwd ?? this.workDir)
    this.sessions.set(session.id, session)

    // Re-emit session events at context scope with the session id attached.
    // The global context also forwards to the process-wide bus that transport
    // layers subscribe to for the main-chat UI.
    session.on('data', (data: string) => {
      const event = { sessionId: session.id, data }
      this.emit('data', event)
      if (this.global) emitTerminalData(event)
    })
    session.on('exit', () => {
      const event = { sessionId: session.id, type: 'exited' as const, info: session.info }
      this.emit('lifecycle', event)
      if (this.global) emitTerminalLifecycle(event)
      // Keep this session for replay, but evict older exited ones so their
      // screen/replay buffers don't accumulate for the life of the context.
      this.pruneExitedSessions(session.id)
    })
    session.on('title', () => {
      const event = { sessionId: session.id, type: 'title' as const, info: session.info }
      this.emit('lifecycle', event)
      if (this.global) emitTerminalLifecycle(event)
    })

    const created = { sessionId: session.id, type: 'created' as const, info: session.info }
    this.emit('lifecycle', created)
    if (this.global) emitTerminalLifecycle(created)
    return session
  }

  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id)
  }

  list(): TerminalInfo[] {
    return [...this.sessions.values()].map(s => s.info)
  }

  kill(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.kill()
    this.sessions.delete(id)
    return true
  }

  /** Signal that the AI is (or is not) actively writing to a session. */
  markAiActivity(id: string, writing: boolean): void {
    const session = this.sessions.get(id)
    if (!session) return
    const event = { sessionId: id, type: 'ai-activity' as const, info: session.info, aiWriting: writing }
    this.emit('lifecycle', event)
    if (this.global) emitTerminalLifecycle(event)
  }

  private liveCount(): number {
    let n = 0
    for (const s of this.sessions.values()) if (s.state === 'running') n++
    return n
  }

  /**
   * Evict the oldest exited sessions beyond {@link MAX_EXITED_RETAINED}, freeing
   * their screen/replay buffers via kill(). `keepId` (the just-exited session) is
   * always retained so its exit banner + replay stay available. Evicted sessions
   * drop out of list(), so the renderer removes them on its next refresh.
   */
  private pruneExitedSessions(keepId: string): void {
    const exited = Array.from(this.sessions.values()).filter(s => s.state === 'exited' && s.id !== keepId)
    if (exited.length < MAX_EXITED_RETAINED) return
    exited.sort((a, b) => a.info.lastActivityAt - b.info.lastActivityAt)
    for (const s of exited.slice(0, exited.length - (MAX_EXITED_RETAINED - 1))) {
      s.kill()
      this.sessions.delete(s.id)
    }
  }

  /** Destroy every session (context teardown). */
  destroy(): void {
    for (const s of this.sessions.values()) s.kill()
    this.sessions.clear()
    this.removeAllListeners()
  }
}

// Global singleton for the interactive main-chat terminal.
let globalContext: TerminalContext | null = null

export function getGlobalTerminalContext(workDir: string): TerminalContext {
  if (!globalContext) {
    globalContext = new TerminalContext(workDir, true)
  } else {
    globalContext.setWorkDir(workDir)
  }
  return globalContext
}

export function peekGlobalTerminalContext(): TerminalContext | null {
  return globalContext
}

/** Isolated context for an automation run. Caller owns destroy(). */
export function createScopedTerminalContext(workDir: string): TerminalContext {
  return new TerminalContext(workDir)
}

/** Shutdown hook (bootstrap/extended.ts). */
export function cleanupAITerminal(): void {
  if (globalContext) {
    globalContext.destroy()
    globalContext = null
    console.log('[AI Terminal] Global context cleaned up')
  }
}
