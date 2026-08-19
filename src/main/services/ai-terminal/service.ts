/**
 * AI Terminal - Service entry (user/transport-facing)
 *
 * Thin façade the IPC/HTTP/WS layers call for user-initiated terminal
 * operations (list / input / resize / kill / create / replay / viewer
 * attach-detach-ack). Operates on the global (main-chat) context.
 * AI-initiated operations go through the MCP tools.
 */

import { getGlobalTerminalContext, peekGlobalTerminalContext } from './context'
import { isTerminalAvailable } from './available'
import type { CreateTerminalOptions, TerminalInfo } from '../../../shared/types/terminal'

export interface TerminalCreateResult {
  ok: boolean
  info?: TerminalInfo
  error?: string
}

/** List current sessions (empty when no context/session exists yet). */
export function listTerminals(): TerminalInfo[] {
  return peekGlobalTerminalContext()?.list() ?? []
}

/** User keyboard input → pty. */
export function terminalInput(sessionId: string, data: string): boolean {
  const session = peekGlobalTerminalContext()?.get(sessionId)
  if (!session) return false
  session.input(data)
  return true
}

/** UI fit-addon resize → pty + headless. */
export function terminalResize(sessionId: string, cols: number, rows: number): boolean {
  const session = peekGlobalTerminalContext()?.get(sessionId)
  if (!session) return false
  session.resize(cols, rows)
  return true
}

/** User closes a session. */
export function killTerminal(sessionId: string): boolean {
  return peekGlobalTerminalContext()?.kill(sessionId) ?? false
}

/** Raw output for replaying into a freshly-attached xterm viewer. */
export async function getTerminalReplay(sessionId: string): Promise<{ info: TerminalInfo; data: string } | null> {
  const session = peekGlobalTerminalContext()?.get(sessionId)
  if (!session) return null
  try {
    return await session.getReplay()
  } catch {
    // Session vanished worker-side (exit/evict/crash race).
    return null
  }
}

/**
 * A viewer (desktop tab or remote WS client) started/stopped consuming a
 * session's live stream, or acknowledges rendered chars. Drives flow control:
 * with viewers attached, an un-acked backlog past the high watermark pauses
 * the pty until the slowest viewer catches up (see flow-control.ts).
 */
export function terminalViewerAttach(sessionId: string, viewerId: string): boolean {
  const ctx = peekGlobalTerminalContext()
  if (!ctx?.get(sessionId)) return false
  ctx.flow.attach(sessionId, viewerId)
  return true
}

export function terminalViewerDetach(sessionId: string, viewerId: string): void {
  peekGlobalTerminalContext()?.flow.detach(sessionId, viewerId)
}

export function terminalViewerAck(sessionId: string, viewerId: string, charCount: number): void {
  if (!Number.isFinite(charCount) || charCount <= 0) return
  peekGlobalTerminalContext()?.flow.ack(sessionId, viewerId, charCount)
}

/** Drop every attachment of a viewer (remote WS client disconnected). */
export function terminalViewerDisconnected(viewerId: string): void {
  peekGlobalTerminalContext()?.flow.detachViewer(viewerId)
}

/**
 * User-initiated session creation. `spaceId` tags the session for per-space
 * isolation so the AI's terminal tools in one space never see another space's
 * sessions (including a terminal the user pre-authenticated for AI takeover).
 */
export async function createTerminalForUser(
  spaceId: string,
  workDir: string,
  opts: Omit<CreateTerminalOptions, 'owner' | 'spaceId'>
): Promise<TerminalCreateResult> {
  if (!isTerminalAvailable()) {
    return { ok: false, error: 'Terminal is not available on this platform' }
  }
  try {
    const ctx = getGlobalTerminalContext(workDir)
    const session = await ctx.create({ ...opts, owner: 'user', spaceId })
    return { ok: true, info: session.info }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
