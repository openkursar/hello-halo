/**
 * AI Terminal - Session
 *
 * One pty process + a headless xterm screen buffer. The pty is the single
 * source of truth: user and AI write to the same stream and see the same
 * interpreted screen. Raw ANSI is never handed to the model — the AI reads
 * from the interpreted buffer (screen / scrollback) or from write-and-wait
 * output, all derived from @xterm/headless.
 *
 * Command completion is detected with a shell-agnostic output-idle heuristic.
 * OSC 133 markers are parsed opportunistically (if the user's shell or a remote
 * host already emits them, we get precise boundaries + exit codes for free),
 * but we never inject prompt hacks ourselves — that mangles custom prompts and
 * differs per shell. The idle heuristic is also exactly what the SSH/remote
 * path needs, so it is a first-class mechanism, not a fallback.
 */

import type { IPty, IDisposable } from 'node-pty'
import { createRequire } from 'module'
import { Terminal } from '@xterm/headless'
import { EventEmitter } from 'events'
import { resolveShell } from './shell'
import {
  MAX_RETURN_LINES,
  defaultTitle,
  classifyCompletion,
  trimTrailingBlank,
  diffTail,
  capOutput,
  safeRegExp,
  endsAtPrompt,
  joinWrappedLines,
  toPtyWrites
} from './text-utils'

// node-pty is a native addon that is intentionally NOT packaged on Linux
// (afterPack excludes its prebuilds). Load it lazily via require so merely
// importing this module (e.g. through the toolset registry on every platform)
// never touches the native binding — only constructing a session does, which
// is gated behind isTerminalAvailable() and thus never happens on Linux.
const nodeRequire = createRequire(import.meta.url)
type NodePty = typeof import('node-pty')
let ptyModule: NodePty | null = null
function loadPty(): NodePty {
  if (!ptyModule) ptyModule = nodeRequire('node-pty') as NodePty
  return ptyModule
}
import type {
  CreateTerminalOptions,
  TerminalInfo,
  TerminalReadMode,
  TerminalReadResult,
  TerminalRunState,
  TerminalSearchResult,
  TerminalWriteResult
} from './types'

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 30
const SCROLLBACK_LIMIT = 10000
/** Idle heuristic: ms of no output that counts as "settled" when OSC133 absent */
const IDLE_MS = 500
const DEFAULT_WRITE_TIMEOUT_MS = 10_000
/**
 * Delay before the split-off submit Enter (see deliverInput). It only has to
 * push the CR into a pty read separate from the body; an event-loop tick already
 * works, and this margin keeps it reliable under load and on ConPTY while staying
 * imperceptible next to the write-and-wait idle window.
 */
const SUBMIT_KEY_DELAY_MS = 20
/** Raw replay buffer cap (bytes) for late-attaching UI viewers */
const REPLAY_BUFFER_BYTES = 256_000

let seq = 0

export class TerminalSession extends EventEmitter {
  readonly id: string
  private proc: IPty
  private term: Terminal
  readonly info: TerminalInfo

  /** Bounded raw output ring for UI replay when a viewer attaches late */
  private replayBuffer = ''
  /** Resolver for an in-flight write-and-wait */
  private waitResolve: ((r: TerminalWriteResult) => void) | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private waitTimer: NodeJS.Timeout | null = null
  /** Pending split-off submit Enter (see deliverInput) */
  private submitTimer: NodeJS.Timeout | null = null
  /** Last command exit code parsed from OSC 133;D */
  private lastExitCode: number | null = null
  /** Set when OSC 133;D fires during a wait window */
  private sawCommandEnd = false
  /** Marks the "already read" watermark for mode:'new' */
  private newReadConsumed = ''
  /** True once kill() has run; guards late pty callbacks against a disposed xterm */
  private disposed = false
  /**
   * Resolves once one-time session hardening (see prime()) has run. AI writes
   * await this so the first command never races the priming command. Resolved
   * immediately for sessions that need no priming (user-owned, non-posix shell).
   */
  private ready!: Promise<void>
  private readyResolve!: () => void
  /** pty output listener; detached on kill() before the xterm buffer is disposed */
  private dataListener: IDisposable | null = null
  /** pty exit listener */
  private exitListener: IDisposable | null = null

  constructor(opts: CreateTerminalOptions, workDir: string) {
    super()
    this.id = `term_${++seq}_${Date.now().toString(36)}`

    const shell = resolveShell(opts.shell)
    const cols = opts.cols ?? DEFAULT_COLS
    const rows = opts.rows ?? DEFAULT_ROWS
    const cwd = opts.cwd ?? workDir

    this.term = new Terminal({
      cols,
      rows,
      scrollback: SCROLLBACK_LIMIT,
      allowProposedApi: true
    })

    // Custom OSC 133 handler for command/exit-code tracking.
    this.term.parser.registerOscHandler(133, (data: string) => {
      this.handleOsc133(data)
      return true
    })

    this.proc = loadPty().spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, ...shell.env } as Record<string, string>
    })

    this.info = {
      id: this.id,
      title: opts.title || defaultTitle(shell.file),
      shell: shell.file,
      cwd,
      cols,
      rows,
      owner: opts.owner,
      state: 'running',
      exitCode: null,
      lastActivityAt: Date.now(),
      createdAt: Date.now(),
      spaceId: opts.spaceId
    }

    this.dataListener = this.proc.onData((chunk) => this.onData(chunk))
    this.exitListener = this.proc.onExit(({ exitCode }) => this.onExit(exitCode))

    this.ready = new Promise<void>((resolve) => { this.readyResolve = resolve })
    // AI-owned posix sessions get one-time hardening; everything else is ready
    // to accept commands immediately.
    if (opts.owner === 'ai' && shell.family === 'posix') {
      this.prime()
    } else {
      this.readyResolve()
    }
  }

  /**
   * One-time hardening for AI-driven posix shells, run before the first AI
   * command. Disables interactive history expansion (`!`), which in an
   * interactive shell mangles quote parsing and wedges the parser at a
   * continuation prompt (`echo "done!"` → zsh stuck at `dquote>`) — a footgun
   * that only exists because the AI drives a real interactive shell.
   *
   * This is a single startup command, NOT a per-prompt PS1/PROMPT_COMMAND hook:
   * it does not run on every prompt, does not touch the user's prompt, and does
   * not emit escape sequences into the read buffer — so it sidesteps the reasons
   * prompt injection was rejected (see DESIGN.md §4). `set -o histexpand` is the
   * one spelling both bash and zsh accept. Its echo is swallowed from the AI's
   * incremental view by advancing the read watermark once the prompt returns.
   */
  private prime(): void {
    this.proc.write('set +o histexpand 2>/dev/null\n')
    const start = Date.now()
    const poll = (): void => {
      if (this.disposed || this.info.state === 'exited') { this.readyResolve(); return }
      const rendered = this.renderAll()
      const settled = rendered.includes('histexpand') && endsAtPrompt(rendered)
      if (settled || Date.now() - start > 2000) {
        // Swallow the priming command from mode:'new' and write diffs.
        this.newReadConsumed = rendered
        this.waitBefore = rendered
        this.readyResolve()
        return
      }
      setTimeout(poll, 40)
    }
    setTimeout(poll, 40)
  }

  // ============================================
  // pty I/O
  // ============================================

  private onData(chunk: string): void {
    // A killed session may still receive buffered pty output before the OS
    // tears the process down. The xterm buffer is already disposed, so writing
    // to it would throw inside a pty callback (uncaught). Drop late data.
    if (this.disposed) return
    this.term.write(chunk)
    this.info.lastActivityAt = Date.now()

    // Maintain a bounded raw replay buffer so a viewer opened later can
    // reproduce the current screen faithfully (colors/cursor) before live data.
    this.replayBuffer += chunk
    if (this.replayBuffer.length > REPLAY_BUFFER_BYTES) {
      this.replayBuffer = this.replayBuffer.slice(this.replayBuffer.length - REPLAY_BUFFER_BYTES)
    }

    // Live stream to UI (renderer xterm renders ANSI faithfully)
    this.emit('data', chunk)

    if (this.waitResolve) {
      // Reset idle timer; if OSC133 end already seen, resolve now.
      if (this.sawCommandEnd) {
        this.settleWait('command-complete')
      } else {
        this.armIdleTimer()
      }
    }
  }

  private onExit(exitCode: number): void {
    this.info.state = 'exited'
    this.info.exitCode = exitCode
    // settleWait renders the (still-live) buffer, so only run it when the term
    // has not been disposed by kill(). On a user kill, waitResolve is already
    // settled and nulled, so this is a no-op there anyway.
    if (this.waitResolve && !this.disposed) this.settleWait('exited')
    this.emit('exit', exitCode)
    try { this.exitListener?.dispose() } catch { /* already gone */ }
    this.exitListener = null
  }

  private handleOsc133(data: string): void {
    // data is the payload after "133;" — e.g. "A", "B", "C", "D;0".
    // Only 133;D (command finished + exit code) is consumed. A/B/C mark
    // prompt/command boundaries, but a fresh prompt (B) after completion must
    // NOT be read as "command awaiting input" — that conflated a finished
    // command with an interactive wait. Completion is detected by D or the
    // idle heuristic; interactive input waits by the input-prompt heuristic.
    const [kind, arg] = data.split(';')
    if (kind === 'D') {
      this.lastExitCode = arg !== undefined && arg !== '' ? Number(arg) : null
      this.sawCommandEnd = true
    }
  }

  // ============================================
  // Write-and-wait
  // ============================================

  /**
   * Write input to the pty and wait for the command to settle. Returns the new
   * interpreted output produced during the wait. Resolves on: OSC133 command
   * end, output idle (heuristic), timeout, or process exit.
   */
  async write(input: string, timeoutMs = DEFAULT_WRITE_TIMEOUT_MS, submit = true): Promise<TerminalWriteResult> {
    // Never let the first AI command race one-time session priming.
    await this.ready

    if (this.info.state === 'exited') {
      return {
        output: '', reason: 'exited', running: false,
        exitCode: this.info.exitCode, awaitingInput: false, awaitingContinuation: false, truncated: false
      }
    }

    // A previous write-and-wait may still be in flight (AI retried, or a
    // parallel tool call). Settle it now with whatever accumulated so its
    // caller never hangs and its timer is cleared before we start a new wait.
    if (this.waitResolve) this.settleWait('superseded')

    // Snapshot the interpreted buffer so we can diff "new" output after the wait.
    const before = this.renderAll()

    this.sawCommandEnd = false
    this.deliverInput(input, submit)
    this.info.lastActivityAt = Date.now()

    return new Promise<TerminalWriteResult>((resolve) => {
      this.waitResolve = (r) => resolve(r)
      this.waitBefore = before
      this.armIdleTimer()
      this.waitTimer = setTimeout(() => this.settleWait('timeout'), timeoutMs)
    })
  }

  /**
   * Write AI-supplied input to the pty. `submit` true (the default for a command)
   * appends the submitting Enter; false writes the bytes raw with no Enter, to send
   * a keystroke (arrow, Esc) that must not confirm. The byte layout — CR-not-LF and
   * trailing-newline de-duplication — is decided by toPtyWrites.
   *
   * When an Enter is appended it must land in a pty read SEPARATE from the body:
   * Ink-based TUIs (Claude Code, Codex) paste-detect a single read carrying
   * text-then-CR and insert a newline instead of submitting — verified against
   * Claude Code: "cmd\r" in one write does not submit, "cmd" then "\r" (a tick
   * later) does. Writing both in the same tick races (the OS coalesces them into
   * one read), so the split-off Enter is sent after a short delay. Harmless for
   * cooked-mode shells (the tty maps CR→NL regardless of split).
   */
  private deliverInput(input: string, submit: boolean): void {
    // Cancel any Enter still pending from a previous, superseded write so it
    // cannot land in the middle of this one.
    if (this.submitTimer) { clearTimeout(this.submitTimer); this.submitTimer = null }

    const chunks = toPtyWrites(input, submit)
    if (chunks.length === 0) return
    if (chunks.length === 1) { this.proc.write(chunks[0]); return }

    // chunks === [body, '\r']: body now, submit Enter in its own later read.
    this.proc.write(chunks[0])
    this.submitTimer = setTimeout(() => {
      this.submitTimer = null
      if (this.disposed || this.info.state === 'exited') return
      try { this.proc.write('\r') } catch { /* pty already gone */ }
      this.info.lastActivityAt = Date.now()
    }, SUBMIT_KEY_DELAY_MS)
  }

  private waitBefore = ''

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    // Output-idle heuristic: N ms with no new output = command settled.
    // OSC 133;D (when a shell/remote emits it) short-circuits this via onData.
    this.idleTimer = setTimeout(() => {
      if (this.waitResolve) this.settleWait(this.sawCommandEnd ? 'command-complete' : 'idle')
    }, IDLE_MS)
  }

  private settleWait(reason: TerminalWriteResult['reason']): void {
    if (!this.waitResolve) return
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    if (this.waitTimer) { clearTimeout(this.waitTimer); this.waitTimer = null }

    const after = this.renderAll()
    const delta = diffTail(this.waitBefore, after)
    const { text, truncated } = capOutput(delta)

    const resolve = this.waitResolve
    this.waitResolve = null

    // Advance the mode:'new' watermark to current screen state.
    this.newReadConsumed = after

    const { running, awaitingInput, awaitingContinuation, exitCode } = classifyCompletion({
      after,
      sawCommandEnd: this.sawCommandEnd,
      lastExitCode: this.lastExitCode,
      settledByHeuristic: reason === 'timeout' || reason === 'idle' || reason === 'superseded'
    })

    resolve({ output: text, reason, running, exitCode, awaitingInput, awaitingContinuation, truncated })
  }

  // ============================================
  // Reads (three modes)
  // ============================================

  read(mode: TerminalReadMode, opts: {
    lines?: number
    offset?: number
  } = {}): TerminalReadResult {
    // A disposed (killed) session has no buffer to render; return empty rather
    // than throwing inside the xterm buffer accessor.
    if (this.disposed) return { mode, content: '', truncated: false }
    switch (mode) {
      case 'screen':
        return this.readScreen()
      case 'scrollback':
        return this.readScrollback(opts)
      case 'new':
      default:
        return this.readNew()
    }
  }

  /**
   * Grep the interpreted history for `pattern` (smart-case regex), returning
   * matching lines with ±context and 1-based line numbers, plus the total match
   * count before the harness cap. This is the content-query counterpart to the
   * positional reads above (terminal_search vs terminal_read). Safe on a
   * disposed session.
   */
  search(pattern: string, context = 2): TerminalSearchResult {
    if (this.disposed) return { content: '', totalMatches: 0, truncated: false }
    const all = this.renderAll().split('\n')
    const re = safeRegExp(pattern)
    const ctx = Math.max(0, context)
    const keep = new Set<number>()
    let totalMatches = 0
    all.forEach((line, i) => {
      if (re.test(line)) {
        totalMatches++
        for (let j = Math.max(0, i - ctx); j <= Math.min(all.length - 1, i + ctx); j++) {
          keep.add(j)
        }
      }
    })
    const picked = [...keep].sort((a, b) => a - b).map(i => `${i + 1}: ${all[i]}`)
    const { text, truncated } = capOutput(picked.join('\n'), { pagingHint: false })
    return { content: text, totalMatches, truncated }
  }

  /** Incremental output since the last write/read watermark. */
  private readNew(): TerminalReadResult {
    const after = this.renderAll()
    const delta = diffTail(this.newReadConsumed, after)
    this.newReadConsumed = after
    const { text, truncated } = capOutput(delta)
    return { mode: 'new', content: text, truncated }
  }

  /** Rendered viewport grid + cursor — the ground-truth snapshot. */
  private readScreen(): TerminalReadResult {
    const buf = this.term.buffer.active
    const lines: string[] = []
    for (let y = 0; y < this.term.rows; y++) {
      const line = buf.getLine(buf.viewportY + y)
      lines.push(line ? line.translateToString(true) : '')
    }
    const content = trimTrailingBlank(lines).join('\n')
    return {
      mode: 'screen',
      content,
      truncated: false,
      cursor: { row: buf.cursorY, col: buf.cursorX }
    }
  }

  /** Historical lines by position: the last `lines`, paged back by `offset`. */
  private readScrollback(opts: {
    lines?: number
    offset?: number
  }): TerminalReadResult {
    const all = this.renderAll().split('\n')
    const lineCount = opts.lines ?? MAX_RETURN_LINES
    const offset = opts.offset ?? 0
    const end = all.length - offset
    const start = Math.max(0, end - lineCount)
    const slice = all.slice(start, end)
    const { text, truncated } = capOutput(slice.join('\n'))
    return { mode: 'scrollback', content: text, truncated }
  }

  // ============================================
  // Control
  // ============================================

  /** Raw input passthrough (user keyboard from renderer/WS). No waiting. */
  input(data: string): void {
    if (this.disposed || this.info.state === 'exited') return
    this.proc.write(data)
    this.info.lastActivityAt = Date.now()
  }

  /** Raw output buffer for UI replay when a viewer attaches (xterm.write). */
  getReplayData(): string {
    return this.replayBuffer
  }

  /**
   * Snapshot the interpreted buffer as a watermark for terminal_wait_for.
   * Empty on a disposed session.
   */
  snapshotBuffer(): string {
    return this.disposed ? '' : this.renderAll()
  }

  /**
   * Whether `needle` appears in output produced AFTER `baseline` was snapshotted.
   * terminal_wait_for uses this so a needle already present in history (e.g. a
   * previous run's "BUILD SUCCESS", or the command echo itself) cannot falsely
   * satisfy the wait — only genuinely new output counts. It still catches matches
   * that scrolled off-screen between polls, because it diffs against the full
   * interpreted buffer, not just the visible viewport. Safe on a disposed session.
   */
  includesSince(needle: string, baseline: string): boolean {
    if (this.disposed) return false
    return diffTail(baseline, this.renderAll()).includes(needle)
  }

  resize(cols: number, rows: number): void {
    if (this.disposed || this.info.state === 'exited') return
    try {
      this.proc.resize(cols, rows)
      this.term.resize(cols, rows)
      this.info.cols = cols
      this.info.rows = rows
    } catch (e) {
      console.error(`[Terminal ${this.id}] resize failed:`, e)
    }
  }

  setTitle(title: string): void {
    this.info.title = title
    this.emit('title', title)
  }

  get state(): TerminalRunState {
    return this.info.state
  }

  kill(): void {
    if (this.disposed) return
    // Order matters: settle any in-flight wait (so its caller resolves instead
    // of hanging), detach the pty onData listener and mark disposed so buffered
    // output can no longer reach the xterm buffer, THEN dispose the buffer and
    // kill the process. Disposing the buffer before detaching onData would let
    // late pty output write into a disposed term (uncaught throw in a callback).
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    if (this.waitTimer) { clearTimeout(this.waitTimer); this.waitTimer = null }
    if (this.submitTimer) { clearTimeout(this.submitTimer); this.submitTimer = null }
    if (this.waitResolve) {
      const resolve = this.waitResolve
      this.waitResolve = null
      resolve({
        output: '', reason: 'exited', running: false,
        exitCode: this.info.exitCode, awaitingInput: false, awaitingContinuation: false, truncated: false
      })
    }
    this.disposed = true
    // Unblock any write still awaiting priming; it will then see state 'exited'.
    this.readyResolve?.()
    try { this.dataListener?.dispose() } catch { /* already gone */ }
    this.dataListener = null
    try {
      this.proc.kill()
    } catch {
      // already dead
    }
    try {
      this.term.dispose()
    } catch {
      // ignore
    }
  }

  // ============================================
  // Rendering helpers
  // ============================================

  /**
   * Full interpreted text: scrollback + viewport, trailing blanks trimmed.
   * Physically-wrapped rows are rejoined into their logical line so a command
   * or output line longer than the terminal width is not split mid-token (the
   * "HTTP 500" → "50\n0" bug). screen mode keeps the raw grid on purpose (cursor
   * coordinates map to physical rows), so this joining lives only here.
   */
  private renderAll(): string {
    const buf = this.term.buffer.active
    const total = buf.length // includes scrollback + viewport rows
    const rows: { text: string; wrapped: boolean }[] = []
    for (let i = 0; i < total; i++) {
      const line = buf.getLine(i)
      rows.push({ text: line ? line.translateToString(true) : '', wrapped: !!line?.isWrapped })
    }
    return trimTrailingBlank(joinWrappedLines(rows)).join('\n')
  }
}
