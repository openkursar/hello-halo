/**
 * AI Terminal - Service entry (user/transport-facing)
 *
 * Thin façade the IPC/HTTP layers call for user-initiated terminal operations
 * (list / input / resize / kill / create / replay). Operates on the global
 * (main-chat) context. AI-initiated operations go through the MCP tools.
 */

import { getGlobalTerminalContext, peekGlobalTerminalContext } from './context'
import { isTerminalAvailable } from './available'
import type { CreateTerminalOptions, TerminalInfo } from './types'

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
export function getTerminalReplay(sessionId: string): { info: TerminalInfo; data: string } | null {
  const ctx = peekGlobalTerminalContext()
  const session = ctx?.get(sessionId)
  if (!session) return null
  return { info: session.info, data: session.getReplayData() }
}

/**
 * User-initiated session creation. `spaceId` tags the session for per-space
 * isolation so the AI's terminal tools in one space never see another space's
 * sessions (including a terminal the user pre-authenticated for AI takeover).
 */
export function createTerminalForUser(
  spaceId: string,
  workDir: string,
  opts: Omit<CreateTerminalOptions, 'owner' | 'spaceId'>
): TerminalCreateResult {
  if (!isTerminalAvailable()) {
    return { ok: false, error: 'Terminal is not available on this platform' }
  }
  try {
    const ctx = getGlobalTerminalContext(workDir)
    const session = ctx.create({ ...opts, owner: 'user', spaceId })
    return { ok: true, info: session.info }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
