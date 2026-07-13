/**
 * AI Terminal - Types
 *
 * A pty-backed interactive terminal that the AI controls via MCP tools and the
 * user can see and take over. The pty lives in the main process, decoupled from
 * any UI or SDK session — so a task keeps running whether or not the user is
 * watching (activity chip → one-click reveal).
 */

/** How a terminal session was created */
export type TerminalOwner = 'ai' | 'user'

/** Run state of a session */
export type TerminalRunState = 'running' | 'exited'

/** Options for creating a session */
export interface CreateTerminalOptions {
  /** Shell executable; defaults to the platform login shell */
  shell?: string
  /** Working directory; defaults to the space working dir */
  cwd?: string
  /** Initial columns (UI drives resize afterwards; AI does not control size) */
  cols?: number
  /** Initial rows */
  rows?: number
  /** Human-facing title */
  title?: string
  /** Who created the session */
  owner: TerminalOwner
  /**
   * Owning space id. Sessions are isolated by space: the AI's terminal_* tools
   * only see sessions from their own space, so an agent in one space cannot
   * list/read/write another space's terminals (e.g. a pre-authenticated SSH
   * session). Undefined only for legacy/untagged callers.
   */
  spaceId?: string
}

/** Public metadata for a session (terminal_list, UI) */
export interface TerminalInfo {
  id: string
  title: string
  shell: string
  cwd: string
  cols: number
  rows: number
  owner: TerminalOwner
  state: TerminalRunState
  exitCode: number | null
  /** ms epoch of last output or input */
  lastActivityAt: number
  createdAt: number
  /** Owning space id (for per-space isolation of the AI's terminal tools) */
  spaceId?: string
}

/** Result of a write-and-wait cycle */
export interface TerminalWriteResult {
  /** New output produced during the wait (interpreted screen text, not raw ANSI) */
  output: string
  /** Why the wait returned */
  reason: 'command-complete' | 'idle' | 'timeout' | 'exited' | 'superseded'
  /** Whether the command appears still running (timeout with no end marker) */
  running: boolean
  /** Exit code of the last command if known (OSC 133;D), else null */
  exitCode: number | null
  /** True when the shell appears to be waiting for interactive input */
  awaitingInput: boolean
  /**
   * True when the shell is wedged at a PS2 continuation prompt (unterminated
   * quote / open here-doc / dangling operator). The caller must send the
   * closing delimiter or an interrupt (Ctrl-C) rather than a new command.
   */
  awaitingContinuation: boolean
  /** Output truncated to the harness cap */
  truncated: boolean
}

/**
 * Read modes for terminal_read. All three are POSITIONAL reads of the buffer
 * (current view or a slice of history) — content search lives in its own
 * terminal_search tool, so no read mode carries a pattern.
 */
export type TerminalReadMode = 'new' | 'screen' | 'scrollback'

/** Result of a read */
export interface TerminalReadResult {
  mode: TerminalReadMode
  content: string
  truncated: boolean
  /** Cursor position for screen mode (row,col are 0-based, viewport-relative) */
  cursor?: { row: number; col: number }
}

/** Result of a scrollback search (terminal_search) */
export interface TerminalSearchResult {
  /** Matching lines with ±context and 1-based line numbers */
  content: string
  /** Total matching lines in history before the harness cap */
  totalMatches: number
  /** Result truncated to the harness cap */
  truncated: boolean
}

/** Data event pushed to renderer / WS for live rendering */
export interface TerminalDataEvent {
  sessionId: string
  /** Raw pty output chunk (renderer xterm renders ANSI faithfully) */
  data: string
}

/** Lifecycle event pushed to renderer / WS */
export interface TerminalLifecycleEvent {
  sessionId: string
  type: 'created' | 'exited' | 'title' | 'ai-activity'
  info?: TerminalInfo
  /** For 'ai-activity': whether the AI is currently writing */
  aiWriting?: boolean
}
