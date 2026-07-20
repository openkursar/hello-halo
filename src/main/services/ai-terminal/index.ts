/**
 * AI Terminal Module - Public API
 *
 * Interactive pty terminal that the AI controls via MCP tools and the user can
 * see and take over. Registered as an on-demand toolset (see agent/toolsets).
 *
 * Platform note: Linux is intentionally excluded at the packaging layer
 * (node-pty prebuilds omitted). isTerminalAvailable() gates the whole feature
 * so it never appears in the capability index / menu on unsupported platforms.
 */

export { createTerminalMcpServer } from './sdk-mcp-server'
export {
  createScopedTerminalContext,
  getGlobalTerminalContext,
  peekGlobalTerminalContext,
  cleanupAITerminal
} from './context'
export { isTerminalAvailable } from './available'
export {
  listTerminals,
  terminalInput,
  terminalResize,
  killTerminal,
  getTerminalReplay,
  createTerminalForUser
} from './service'
export {
  onTerminalData,
  onTerminalLifecycle
} from './events'
export type { TerminalContext } from './context'
export type {
  TerminalInfo,
  TerminalDataEvent,
  TerminalLifecycleEvent,
  CreateTerminalOptions
} from './types'

export const AI_TERMINAL_SYSTEM_PROMPT = `
## AI Terminal

You can control interactive terminal sessions. All terminal tools are prefixed with mcp__ai-terminal__.

### Core Workflow
1. \`terminal_create\` — start a session (a persistent shell). Returns a session id.
2. \`terminal_write\` — send a command (include the trailing newline) and get its output in one call.
3. \`terminal_read\` — read more output by position: mode "new" to poll, "screen" for the ground-truth current screen, "scrollback" to page back through history.
4. \`terminal_search\` — regex-search a session's history for matching lines (smart-case), to filter noisy output down to the signal.
5. \`terminal_wait_for\` — block until expected text appears (long tasks, prompts).
6. \`terminal_kill\` — end a session.

### Key Rules
- For a single one-off command, prefer the Bash tool. Use terminal sessions for interactive/stateful work (SSH, REPLs, long processes).
- The user shares these terminals: they see every command you send and can type too. Ctrl+C is always theirs.
- SSH / remote login: create a session, run \`ssh user@host\`, then ask the user to enter the password/passphrase themselves — do NOT read the screen during credential entry. Use \`terminal_wait_for\` on a success prompt, then take over.
- On remote shells, \`terminal_write\` may return status "running" (no precise end marker); poll with \`terminal_read(mode:"new")\` or block with \`terminal_wait_for\`.
- If \`terminal_write\` returns "awaiting continuation", the shell is wedged mid-statement (unterminated quote / open here-doc). Do NOT send a new command — send the missing closing delimiter, or send input \`"\\u0003"\` (Ctrl-C) to cancel and retry.
- For progress bars / spinners / TUIs, read \`mode:"screen"\` — it gives the clean final state.
- After the user has typed in a session, re-read \`mode:"screen"\` to resync before continuing.
- Huge output: use \`terminal_search\` to filter history down to matching lines, or tee to a file and use Grep.
`
