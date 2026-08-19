/**
 * Pty Host worker — entry point.
 *
 * Runs in a separate OS process (child_process.fork), owning every pty session
 * and its @xterm/headless interpretation. This isolates the Electron main
 * process from everything that made in-main ptys fragile on weak/locked-down
 * machines: node-pty's synchronous native spawn (seconds under endpoint
 * scanning), per-chunk ANSI parsing, and ConPTY quirks.
 *
 * Communication: process.on('message') / process.send()
 * Protocol: see src/shared/protocol/pty-host.protocol.ts
 *
 * HARD CONSTRAINT: This file MUST NOT import anything from 'electron' or
 * src/main — shell/space policy lives in main; this process only executes
 * fully-resolved specs.
 */

import type {
  MainToPtyHostMessage,
  PtyHostRequest,
  PtyHostToMainMessage
} from '../../shared/protocol/pty-host.protocol'
import { TerminalSession } from './session'

/** Hard cap on concurrent live sessions (guards runaway spawning) */
const MAX_SESSIONS = 12

/**
 * How many exited sessions to keep for read-only replay before evicting the
 * oldest. An exited pty holds no process, but its @xterm/headless screen buffer
 * (up to the scrollback cap) and replay buffer stay resident until disposed, so
 * unbounded retention leaks memory across a long-lived app run.
 */
const MAX_EXITED_RETAINED = 8

const sessions = new Map<string, TerminalSession>()

// --- Messaging ---

function send(message: PtyHostToMainMessage): void {
  if (process.send) {
    process.send(message)
  }
}

function log(level: 'info' | 'warn' | 'error', message: string): void {
  send({ type: 'log', level, message })
}

function respondError(requestId: string, error: string): void {
  send({ type: 'response', requestId, ok: false, error })
}

// --- Session lifecycle ---

function liveCount(): number {
  let n = 0
  for (const s of sessions.values()) if (s.state === 'running') n++
  return n
}

async function createSession(msg: Extract<PtyHostRequest, { type: 'create' }>): Promise<void> {
  if (liveCount() >= MAX_SESSIONS) {
    respondError(msg.requestId, `Terminal session limit reached (${MAX_SESSIONS}). Close a session first.`)
    return
  }
  const session = new TerminalSession(msg.spec)
  sessions.set(session.id, session)

  session.on('data', (data: string) => {
    send({ type: 'data', sessionId: session.id, data })
  })
  session.on('exit', (exitCode: number) => {
    send({ type: 'exit', sessionId: session.id, exitCode, info: session.info })
    pruneExitedSessions(session.id)
  })

  try {
    await session.start()
  } catch (e) {
    sessions.delete(session.id)
    session.dispose()
    respondError(msg.requestId, e instanceof Error ? e.message : String(e))
    return
  }
  send({ type: 'response', requestId: msg.requestId, ok: true, data: { info: session.info } })
}

/**
 * Evict the oldest exited sessions beyond MAX_EXITED_RETAINED, freeing their
 * screen/replay buffers. `keepId` (the just-exited session) is always retained
 * so its exit banner + replay stay available. Main is told via 'evicted' so it
 * drops the matching proxies (and the renderer on its next list refresh).
 */
function pruneExitedSessions(keepId: string): void {
  const exited = Array.from(sessions.values()).filter(s => s.state === 'exited' && s.id !== keepId)
  if (exited.length < MAX_EXITED_RETAINED) return
  exited.sort((a, b) => a.info.lastActivityAt - b.info.lastActivityAt)
  for (const s of exited.slice(0, exited.length - (MAX_EXITED_RETAINED - 1))) {
    s.dispose()
    sessions.delete(s.id)
    send({ type: 'evicted', sessionId: s.id })
  }
}

function disposeAll(): void {
  for (const s of sessions.values()) s.dispose()
  sessions.clear()
}

// --- Request dispatch ---

async function handleRequest(msg: PtyHostRequest): Promise<void> {
  if (msg.type === 'create') {
    await createSession(msg)
    return
  }

  const session = sessions.get(msg.sessionId)
  if (!session) {
    respondError(msg.requestId, `No such terminal session: ${msg.sessionId}`)
    return
  }

  switch (msg.type) {
    case 'write': {
      const result = await session.write(msg.input, msg.timeoutMs, msg.submit)
      send({ type: 'response', requestId: msg.requestId, ok: true, data: result })
      break
    }
    case 'read': {
      const result = session.read(msg.mode, { lines: msg.lines, offset: msg.offset })
      send({ type: 'response', requestId: msg.requestId, ok: true, data: result })
      break
    }
    case 'search': {
      const result = session.search(msg.pattern, msg.context)
      send({ type: 'response', requestId: msg.requestId, ok: true, data: result })
      break
    }
    case 'wait-for': {
      const outcome = await session.waitFor(msg.text, msg.timeoutMs)
      // Bundle the context the tool reply needs, so the wait is a single RPC:
      // screen on success, final/recent output otherwise.
      const content =
        outcome === 'found' ? session.read('screen').content :
        outcome === 'exited' ? session.read('scrollback', { lines: 40 }).content :
        session.read('new').content
      send({ type: 'response', requestId: msg.requestId, ok: true, data: { outcome, content } })
      break
    }
    case 'replay': {
      send({
        type: 'response', requestId: msg.requestId, ok: true,
        data: { info: session.info, data: session.getReplayData() }
      })
      break
    }
    case 'mark-ai-touched': {
      const flipped = session.markAiTouched()
      send({ type: 'response', requestId: msg.requestId, ok: true, data: { flipped, info: session.info } })
      break
    }
  }
}

async function handleMessage(msg: MainToPtyHostMessage): Promise<void> {
  try {
    switch (msg.type) {
      // Fire-and-forget notifications (latency-sensitive; a missing session is
      // benign — it exited or was evicted between the caller's check and now).
      case 'input':
        sessions.get(msg.sessionId)?.input(msg.data)
        break
      case 'resize':
        sessions.get(msg.sessionId)?.resize(msg.cols, msg.rows)
        break
      case 'kill': {
        const session = sessions.get(msg.sessionId)
        if (session) {
          session.dispose()
          sessions.delete(msg.sessionId)
        }
        break
      }
      case 'pause':
        sessions.get(msg.sessionId)?.pause()
        break
      case 'resume':
        sessions.get(msg.sessionId)?.resume()
        break
      case 'shutdown':
        disposeAll()
        process.exit(0)
        break
      default:
        await handleRequest(msg)
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    log('error', `Failed to handle message ${msg.type}: ${errMsg}`)
    if ('requestId' in msg) {
      respondError(msg.requestId, errMsg)
    }
  }
}

// --- Bootstrap ---

process.on('message', (msg: MainToPtyHostMessage) => {
  void handleMessage(msg)
})

process.on('SIGTERM', () => {
  log('info', 'Received SIGTERM, shutting down...')
  disposeAll()
  process.exit(0)
})

// The fork IPC channel closed without a shutdown message: main was SIGKILLed
// or crashed natively. Live pty fds would otherwise keep this event loop (and
// every shell tree under it) alive as OS-level orphans, accumulating one
// worker per hard-kill of the app.
process.on('disconnect', () => {
  disposeAll()
  process.exit(0)
})

process.on('SIGINT', () => {
  disposeAll()
  process.exit(0)
})

// A pty callback throwing must not take down every other session silently:
// log it and keep the process alive; main's exit handler covers a real crash.
process.on('uncaughtException', (err) => {
  log('error', `Uncaught exception: ${err.stack || err.message}`)
})

log('info', 'Pty host worker started')
