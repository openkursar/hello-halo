/**
 * AI Terminal - MCP server (7 tools)
 *
 * Design principles (mirror browser_* tools):
 *  - common path is one call (terminal_write returns the command's output);
 *  - read is split by intent: terminal_read is positional (new/screen/scrollback),
 *    terminal_search is the content query (regex grep over history);
 *  - ground truth (screen) is always reachable.
 *
 * Security: terminal_write is arbitrary command execution. It inherits the
 * same trust model as the Bash tool (Halo runs bypassPermissions today); the
 * tool description constrains reading during credential entry.
 */

import { z } from 'zod'
import { tool, createSdkMcpServer } from '../agent/resolved-sdk'
import type { TerminalContext } from './context'

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] })
const errorText = (value: string) => ({ content: [{ type: 'text' as const, text: value }], isError: true })

/** Minimal scope the terminal tools need — the owning space and its working dir. */
export interface TerminalToolScope {
  spaceId: string
  workDir: string
}

export function createTerminalMcpServer(ctx: TerminalContext, scope: TerminalToolScope) {
  // Per-space isolation: the AI's tools only resolve sessions from their own
  // space. The context is a process-global registry shared across spaces (so
  // ptys survive session rebuilds), but an agent in space B must never see or
  // drive space A's sessions — including a pre-authenticated SSH session.
  const getScoped = (id: string) => {
    const s = ctx.get(id)
    return s && s.info.spaceId === scope.spaceId ? s : undefined
  }

  const createTool = tool(
    'terminal_create',
    'Create a new interactive terminal session (a persistent pty running a shell). ' +
    'Use this for tasks that need a live shell: SSH into a remote host, run a REPL, ' +
    'start a long-running process, or any multi-step interactive workflow. For a single ' +
    'one-off command prefer the Bash tool. Returns the session id to use with the other terminal_* tools.',
    {
      shell: z.string().optional().describe('Shell executable path (defaults to the platform login shell)'),
      cwd: z.string().optional().describe('Working directory (defaults to the space working directory)'),
      title: z.string().optional().describe('Human-facing title shown in the UI')
    },
    async (args: { shell?: string; cwd?: string; title?: string }) => {
      try {
        const session = ctx.create({
          shell: args.shell,
          cwd: args.cwd ?? scope.workDir,
          title: args.title,
          owner: 'ai',
          spaceId: scope.spaceId
        })
        return text(
          `Created terminal session "${session.info.title}" (id: ${session.id}), ` +
          `shell: ${session.info.shell}, cwd: ${session.info.cwd}.\n` +
          `Use terminal_write to run commands.`
        )
      } catch (e) {
        return errorText(e instanceof Error ? e.message : String(e))
      }
    }
  )

  const listTool = tool(
    'terminal_list',
    'List all terminal sessions with their id, title, run state, owner (ai/user), and last activity.',
    {},
    async () => {
      const list = ctx.list().filter(s => s.spaceId === scope.spaceId)
      if (list.length === 0) return text('No terminal sessions.')
      const now = Date.now()
      const lines = list.map(s => {
        const idleSec = Math.max(0, Math.round((now - s.lastActivityAt) / 1000))
        return `- ${s.id} [${s.state}${s.exitCode !== null ? ` exit=${s.exitCode}` : ''}] "${s.title}" ` +
          `owner=${s.owner} shell=${s.shell} cwd=${s.cwd} idle=${idleSec}s`
      })
      return text(lines.join('\n'))
    }
  )

  const writeTool = tool(
    'terminal_write',
    'Write input to a terminal session and wait for the result, then return the new output. ' +
    'This is the common path: send a command and get its output back in one call — the command is submitted for ' +
    'you (see submit), so you do not add a newline yourself. ' +
    'Command completion is detected by an output-idle heuristic (plus OSC 133 markers when the shell emits them), ' +
    'so a long-running or remote command may return with status "running" — then poll with ' +
    'terminal_read(mode:"new") or block with terminal_wait_for. ' +
    'The reported exit code is only present when the shell emits OSC 133 end markers; if you need a reliable exit ' +
    'status, run "echo $?" as a follow-up command. ' +
    'If the status is "awaiting continuation" the shell is wedged mid-statement (unterminated quote or open ' +
    'here-doc); do NOT send a new command (it would be swallowed as more of the broken one) — send the missing ' +
    'closing delimiter, or send input "\\u0003" with submit=false (Ctrl-C) to cancel. ' +
    'To interrupt any running command, send input "\\u0003" with submit=false. ' +
    'Input is written to the pty as raw bytes. With submit=false you can operate interactive programs — TUI ' +
    'selection menus, [y/N] prompts, a nested Claude Code/Codex, vim, less — by sending the exact keys a human ' +
    'would press. Write special keys as SINGLE-level escapes that decode to the real control byte (e.g. ' +
    '"\\u001b"), NOT the literal characters backslash-u: arrow keys "\\u001b[A" (up) / "\\u001b[B" (down) / ' +
    '"\\u001b[C" (right) / "\\u001b[D" (left); Esc "\\u001b"; Tab "\\t"; Ctrl-C "\\u0003". ' +
    '(If arrow keys do not register, the app may use application-cursor mode — retry with "\\u001bOA" / ' +
    '"\\u001bOB" / "\\u001bOC" / "\\u001bOD".) ' +
    'Examples: run a command → input "npm run build" (submit defaults to true; no newline needed). ' +
    'Answer a yes/no prompt → input "y". ' +
    'Navigate an arrow-key menu → input "\\u001b[B" with submit=false to move the highlight, then input "" ' +
    '(empty) with submit=true to confirm. ' +
    'Interrupt a running command (Ctrl-C) → input "\\u0003" with submit=false. ' +
    'Do NOT read the screen while the user is entering credentials (e.g. an ssh password prompt).',
    {
      session: z.string().describe('Terminal session id'),
      input: z.string().describe('Text or keys to write, sent to the pty as raw bytes. For a command, send the ' +
        'command text WITHOUT a trailing newline — submit presses Enter for you. Encode special keys as ' +
        'single-level escapes that decode to real control bytes (arrows "\\u001b[A/B/C/D", Esc "\\u001b", Tab ' +
        '"\\t", Ctrl-C "\\u0003"); do NOT double-escape them into literal "\\\\u001b" text.'),
      submit: z.boolean().optional().describe('Press Enter after the input (default true). True runs a command ' +
        'or confirms a prompt — any trailing newline you include is de-duplicated to one Enter, so you never ' +
        'need to add one. Set false to send raw keystrokes with no Enter (e.g. an arrow key or Esc to move ' +
        'through an interactive menu).'),
      timeout: z.number().optional().describe('Max seconds to wait for the command to settle (default 10)')
    },
    async (args: { session: string; input: string; submit?: boolean; timeout?: number }) => {
      const session = getScoped(args.session)
      if (!session) return errorText(`No such terminal session: ${args.session}`)
      ctx.markAiActivity(args.session, true)
      try {
        const result = await session.write(args.input, (args.timeout ?? 10) * 1000, args.submit ?? true)
        const status =
          result.reason === 'exited' ? 'session exited' :
          result.awaitingContinuation ? 'awaiting continuation (shell wedged mid-statement — send the closing ' +
            'quote/here-doc delimiter, or input "\\u0003" to cancel; do NOT send a new command)' :
          result.running ? 'running (command still in progress)' :
          result.awaitingInput ? 'awaiting input' :
          `done${result.exitCode !== null ? ` (exit ${result.exitCode})` : ''}`
        const body = result.output.trim() ? result.output : '(no new output)'
        return text(`[${status}]\n${body}`)
      } catch (e) {
        return errorText(e instanceof Error ? e.message : String(e))
      } finally {
        ctx.markAiActivity(args.session, false)
      }
    }
  )

  const readTool = tool(
    'terminal_read',
    'Read output from a terminal session by position. Modes:\n' +
    '- "new" (default): incremental output since your last read/write. Cheapest; use for polling.\n' +
    '- "screen": the current rendered screen + cursor — the ground truth. Use for progress bars, ' +
    'spinners, interactive prompts ([Y/n]), TUIs (htop/vim), or to resync after the user typed.\n' +
    '- "scrollback": history, newest last, with lines/offset paging (offset = lines from the end). ' +
    'To FIND specific text in history, use terminal_search instead of scanning scrollback. ' +
    'Scrollback is capped (~10k lines); for larger output, tee to a file and use Grep.',
    {
      session: z.string().describe('Terminal session id'),
      mode: z.enum(['new', 'screen', 'scrollback']).optional().describe('Read mode (default "new")'),
      lines: z.number().optional().describe('scrollback: number of lines to return'),
      offset: z.number().optional().describe('scrollback: lines from the end to start at (paging)')
    },
    async (args: {
      session: string; mode?: 'new' | 'screen' | 'scrollback'
      lines?: number; offset?: number
    }) => {
      const session = getScoped(args.session)
      if (!session) return errorText(`No such terminal session: ${args.session}`)
      const result = session.read(args.mode ?? 'new', { lines: args.lines, offset: args.offset })
      const header =
        result.mode === 'screen' && result.cursor
          ? `[screen ${session.info.cols}x${session.info.rows}, cursor ${result.cursor.row},${result.cursor.col}]\n`
          : ''
      const body = result.content.trim() ? result.content : '(empty)'
      return text(header + body)
    }
  )

  const searchTool = tool(
    'terminal_search',
    'Search a terminal session\'s history for lines matching a regular expression, returning each ' +
    'match with surrounding context and its line number. This is how you pull the signal out of noisy ' +
    'output — filter a huge build log down to its errors — instead of reading the whole scrollback. ' +
    'Smart-case: an all-lowercase pattern matches case-insensitively; any uppercase letter makes it ' +
    'case-sensitive (so "error" matches ERROR/Error, "ValueError" matches only that casing). Searches ' +
    'the interpreted history (~10k line cap); for output larger than that, tee to a file and use Grep. ' +
    'If there are too many matches to fit, narrow the pattern.',
    {
      session: z.string().describe('Terminal session id'),
      pattern: z.string().describe('Regular expression (smart-case; an invalid regex is matched literally)'),
      context: z.number().optional().describe('Context lines around each match (default 2)')
    },
    async (args: { session: string; pattern: string; context?: number }) => {
      const session = getScoped(args.session)
      if (!session) return errorText(`No such terminal session: ${args.session}`)
      const result = session.search(args.pattern, args.context)
      if (result.totalMatches === 0) return text(`No lines match /${args.pattern}/.`)
      const header = `[${result.totalMatches} matching line${result.totalMatches === 1 ? '' : 's'}` +
        `${result.truncated ? ' — showing the most recent; narrow the pattern to see fewer' : ''}]\n`
      return text(header + result.content)
    }
  )

  const waitForTool = tool(
    'terminal_wait_for',
    'Block until specific text appears in a session\'s output, or until timeout. ' +
    'Use this to wait on a long task or an expected prompt (e.g. a login success message, ' +
    'a build "done" line) instead of polling terminal_read. Preferred over polling because it ' +
    'reduces token use and avoids reading the screen while sensitive prompts are on it.',
    {
      session: z.string().describe('Terminal session id'),
      text: z.string().describe('Substring to wait for in the output'),
      timeout: z.number().optional().describe('Max seconds to wait (default 60)')
    },
    async (args: { session: string; text: string; timeout?: number }) => {
      const session = getScoped(args.session)
      if (!session) return errorText(`No such terminal session: ${args.session}`)
      const outcome = await waitForText(session, args.text, (args.timeout ?? 60) * 1000)
      if (outcome === 'found') {
        const screen = session.read('screen')
        return text(`Found "${args.text}".\n${screen.content}`)
      }
      if (outcome === 'exited') {
        const recent = session.read('scrollback', { lines: 40 })
        return text(`Session exited before "${args.text}" appeared. Final output:\n${recent.content}`)
      }
      const recent = session.read('new')
      return text(`Timed out waiting for "${args.text}". Recent output:\n${recent.content}`)
    }
  )

  const killTool = tool(
    'terminal_kill',
    'Terminate a terminal session and release its pty.',
    { session: z.string().describe('Terminal session id') },
    async (args: { session: string }) => {
      // Scope-guard: only kill a session that belongs to this space.
      if (!getScoped(args.session)) return errorText(`No such session: ${args.session}`)
      const ok = ctx.kill(args.session)
      return ok ? text(`Killed session ${args.session}.`) : errorText(`No such session: ${args.session}`)
    }
  )

  return createSdkMcpServer({
    name: 'ai-terminal',
    version: '1.0.0',
    tools: [createTool, listTool, writeTool, readTool, searchTool, waitForTool, killTool]
  })
}

type WaitOutcome = 'found' | 'timeout' | 'exited'

/**
 * Poll for `needle` in output produced AFTER this call began, until it appears,
 * the session exits, or the timeout elapses. Anchoring on a baseline snapshot
 * (rather than scanning the whole buffer) prevents a stale match: text already
 * present from an earlier run — or the command echo itself — must not satisfy
 * the wait. It still catches matches that scroll off-screen between ticks, since
 * the "since baseline" diff covers the full interpreted buffer, not just the
 * viewport.
 */
function waitForText(
  session: {
    snapshotBuffer: () => string
    includesSince: (needle: string, baseline: string) => boolean
    state: 'running' | 'exited'
  },
  needle: string,
  timeoutMs: number
): Promise<WaitOutcome> {
  return new Promise((resolve) => {
    const start = Date.now()
    const baseline = session.snapshotBuffer()
    const tick = () => {
      if (session.includesSince(needle, baseline)) return resolve('found')
      if (session.state === 'exited') return resolve('exited')
      if (Date.now() - start >= timeoutMs) return resolve('timeout')
      setTimeout(tick, 250)
    }
    tick()
  })
}
