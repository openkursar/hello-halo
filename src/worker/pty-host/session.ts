/**
 * Pty Host worker - Session
 *
 * One pty process + a headless xterm screen buffer, living in the pty-host
 * worker process so pty I/O, ANSI interpretation, and (synchronous) native
 * spawn calls can never block the Electron main process. The pty is the single
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
 *
 * Three hardening mechanisms guard the pty against known ConPTY / slow-tty
 * failure modes:
 *  - every pty write goes through a chunked write queue (max chunk size +
 *    inter-chunk pacing) so a large paste cannot corrupt a slow tty;
 *  - spawn/kill calls on ConPTY are throttled to dodge a conhost hang that
 *    surfaces when kill and spawn race within a short window;
 *  - the pty can be paused/resumed for flow control (the pause policy itself
 *    lives in the main process, driven by viewer acks).
 */

import type { IPty, IDisposable } from 'node-pty'
import { createRequire } from 'module'
import { platform, release } from 'os'
import { Terminal } from '@xterm/headless'
import { EventEmitter } from 'events'
import type { CreateSessionSpec } from '../../shared/protocol/pty-host.protocol'
import type {
  TerminalInfo,
  TerminalReadMode,
  TerminalReadResult,
  TerminalRunState,
  TerminalSearchResult,
  TerminalWaitOutcome,
  TerminalWriteResult
} from '../../shared/types/terminal'
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
// (afterPack excludes its prebuilds). Load it lazily via require so importing
// this module never touches the native binding — only constructing a session
// does, and the pty-host worker is only forked on platforms where
// isTerminalAvailable() passed in the main process.
const nodeRequire = createRequire(import.meta.url)
type NodePty = typeof import('node-pty')
let ptyModule: NodePty | null = null
function loadPty(): NodePty {
  if (!ptyModule) ptyModule = nodeRequire('node-pty') as NodePty
  return ptyModule
}

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
/** terminal_search safety bounds (model-authored regex) */
const SEARCH_BUDGET_MS = 1000
const SEARCH_LINE_CAP = 2000
/** terminal_wait_for poll interval */
const WAIT_FOR_POLL_MS = 250

// ConPTY / slow-tty hardening constants.
/** Max chars per pty write; larger pastes can be corrupted by a slow tty. */
const WRITE_MAX_CHUNK_SIZE = 50
/** Delay between chunked pty writes. */
const WRITE_INTERVAL_MS = 5
/** Min spacing between ConPTY kill/spawn calls (avoids a conhost hang). */
const KILL_SPAWN_THROTTLE_MS = 250
/** Extra margin when a throttled call waits, to avoid double-interval stacking. */
const KILL_SPAWN_SPACING_MS = 50

/**
 * Whether node-pty will drive this pty with ConPTY (its auto-detection:
 * Windows build >= 18309). The kill/spawn throttle only applies there.
 */
function usesConpty(): boolean {
  if (platform() !== 'win32') return false
  const build = Number(release().split('.')[2] ?? 0)
  return build >= 18309
}

const timeout = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/**
 * Split pty input into chunks that avoid tty-side paste corruption, never
 * splitting an escape sequence across chunks.
 */
export function chunkInput(data: string): string[] {
  const chunks: string[] = []
  let nextChunkStartIndex = 0
  for (let i = 0; i < data.length - 1; i++) {
    if (
      i - nextChunkStartIndex + 1 >= WRITE_MAX_CHUNK_SIZE ||
      data[i + 1] === '\x1b'
    ) {
      chunks.push(data.substring(nextChunkStartIndex, i + 1))
      nextChunkStartIndex = i + 1
      i++
    }
  }
  if (nextChunkStartIndex !== data.length) {
    chunks.push(data.substring(nextChunkStartIndex))
  }
  return chunks
}

let seq = 0

export class TerminalSession extends EventEmitter {
  readonly id: string
  private proc!: IPty
  private term: Terminal
  readonly info: TerminalInfo
  private readonly spec: CreateSessionSpec

  /** Min spacing between ConPTY kill/spawn calls, shared process-wide. */
  private static lastKillOrStart = 0

  /** Bounded raw output ring for UI replay when a viewer attaches late */
  private replayBuffer = ''
  /** Resolver for an in-flight write-and-wait */
  private waitResolve: ((r: TerminalWriteResult) => void) | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private waitTimer: NodeJS.Timeout | null = null
  /** Pending split-off submit Enter (see deliverInput) */
  private submitTimer: NodeJS.Timeout | null = null
  /** Chunked pty write queue (paced by WRITE_INTERVAL_MS) */
  private writeQueue: string[] = []
  private writeTimeout: NodeJS.Timeout | null = null
  /** Flow control: pty paused because viewers are behind (main decides) */
  private ptyPaused = false
  /** Last command exit code parsed from OSC 133;D */
  private lastExitCode: number | null = null
  /** Set when OSC 133;D fires during a wait window */
  private sawCommandEnd = false
  /** Marks the "already read" watermark for mode:'new' */
  private newReadConsumed = ''
  /** True once dispose() has run; guards late pty callbacks against a disposed xterm */
  private disposed = false
  /**
   * Resolves once one-time session hardening (see prime()) has run. AI writes
   * await this so the first command never races the priming command. Resolved
   * immediately for sessions that need no priming (user-owned, non-posix shell).
   */
  private ready!: Promise<void>
  private readyResolve!: () => void
  /** pty output listener; detached on dispose() before the xterm buffer is disposed */
  private dataListener: IDisposable | null = null
  /** pty exit listener */
  private exitListener: IDisposable | null = null

  constructor(spec: CreateSessionSpec) {
    super()
    this.id = `term_${++seq}_${Date.now().toString(36)}`
    this.spec = spec

    const cols = spec.cols ?? DEFAULT_COLS
    const rows = spec.rows ?? DEFAULT_ROWS

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

    this.info = {
      id: this.id,
      title: spec.title || defaultTitle(spec.shell.file),
      shell: spec.shell.file,
      cwd: spec.cwd,
      cols,
      rows,
      owner: spec.owner,
      // An AI-created session is operated by the AI from birth; a user session
      // flips to true the first time an AI tool drives it (markAiTouched).
      aiTouched: spec.owner === 'ai',
      state: 'running',
      exitCode: null,
      lastActivityAt: Date.now(),
      createdAt: Date.now(),
      spaceId: spec.spaceId
    }
  }

  /**
   * Spawn the pty. Separate from the constructor because the ConPTY spawn
   * throttle is async, and because node-pty's spawn is a synchronous native
   * call that may stall for seconds under endpoint-security scanning — the
   * whole reason sessions live in this worker and not in main.
   */
  async start(): Promise<void> {
    await this.throttleKillSpawn()
    const { shell } = this.spec
    this.proc = loadPty().spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: this.info.cols,
      rows: this.info.rows,
      cwd: this.spec.cwd,
      env: { ...process.env, ...shell.env } as Record<string, string>
    })

    this.dataListener = this.proc.onData((chunk) => this.onData(chunk))
    this.exitListener = this.proc.onExit(({ exitCode }) => this.onExit(exitCode))

    this.ready = new Promise<void>((resolve) => { this.readyResolve = resolve })
    // AI-owned posix sessions get one-time hardening; everything else is ready
    // to accept commands immediately.
    if (this.spec.owner === 'ai' && shell.family === 'posix') {
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
    this.queuePtyWrite('set +o histexpand 2>/dev/null\n')
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
    // Settle decisions run in the write callback, after xterm has parsed this
    // chunk: OSC 133;D and the final screen state are only visible then —
    // checking sawCommandEnd synchronously here raced the async parser and
    // could settle a wait with the chunk's tail missing from renderAll().
    this.term.write(chunk, () => {
      if (this.disposed || !this.waitResolve) return
      if (this.sawCommandEnd) {
        this.settleWait('command-complete')
      } else {
        this.armIdleTimer()
      }
    })
    this.info.lastActivityAt = Date.now()

    // Maintain a bounded raw replay buffer so a viewer opened later can
    // reproduce the current screen faithfully (colors/cursor) before live data.
    this.replayBuffer += chunk
    if (this.replayBuffer.length > REPLAY_BUFFER_BYTES) {
      this.replayBuffer = this.replayBuffer.slice(this.replayBuffer.length - REPLAY_BUFFER_BYTES)
    }

    // Live stream to main → renderer (xterm renders ANSI faithfully)
    this.emit('data', chunk)
  }

  private onExit(exitCode: number): void {
    this.info.state = 'exited'
    this.info.exitCode = exitCode
    // settleWait renders the (still-live) buffer, so only run it when the term
    // has not been disposed by dispose(). On a user kill, waitResolve is already
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
  // Chunked write queue
  // ============================================

  /**
   * All pty writes are queued and paced: chunks capped at WRITE_MAX_CHUNK_SIZE
   * with WRITE_INTERVAL_MS between them, escape sequences never split. A large
   * paste written in one syscall corrupts on slow ttys — the exact environment
   * (VDI/SSH) this terminal targets.
   */
  private queuePtyWrite(data: string): void {
    if (!data) return
    this.writeQueue.push(...chunkInput(data))
    this.startWrite()
  }

  private startWrite(): void {
    if (this.writeTimeout !== null || this.writeQueue.length === 0) return
    this.doWrite()
    if (this.writeQueue.length === 0) return
    this.writeTimeout = setTimeout(() => {
      this.writeTimeout = null
      this.startWrite()
    }, WRITE_INTERVAL_MS)
  }

  private doWrite(): void {
    if (this.disposed || this.info.state === 'exited') {
      this.writeQueue.length = 0
      return
    }
    const data = this.writeQueue.shift()!
    try { this.proc.write(data) } catch { /* pty already gone */ }
  }

  private async throttleKillSpawn(): Promise<void> {
    if (!usesConpty()) return
    while (Date.now() - TerminalSession.lastKillOrStart < KILL_SPAWN_THROTTLE_MS) {
      await timeout(KILL_SPAWN_THROTTLE_MS - (Date.now() - TerminalSession.lastKillOrStart) + KILL_SPAWN_SPACING_MS)
    }
    TerminalSession.lastKillOrStart = Date.now()
  }

  // ============================================
  // Flow control (policy in main; mechanics here)
  // ============================================

  pause(): void {
    if (this.disposed || this.info.state === 'exited' || this.ptyPaused) return
    this.ptyPaused = true
    try { this.proc.pause() } catch { /* pty already gone */ }
  }

  resume(): void {
    if (this.disposed || !this.ptyPaused) return
    this.ptyPaused = false
    try { this.proc.resume() } catch { /* pty already gone */ }
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

    // disposed covers the dispose()-to-onExit window where state is still
    // 'running' but the xterm buffer is gone — renderAll/proc.write would throw.
    if (this.disposed || this.info.state === 'exited') {
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
   * later) does. The write queue's chunk pacing does not guarantee the split (a
   * short body + CR fit one chunk), so the Enter is delayed into its own queued
   * write. Harmless for cooked-mode shells (the tty maps CR→NL regardless).
   */
  private deliverInput(input: string, submit: boolean): void {
    // Cancel any Enter still pending from a previous, superseded write so it
    // cannot land in the middle of this one.
    if (this.submitTimer) { clearTimeout(this.submitTimer); this.submitTimer = null }

    const chunks = toPtyWrites(input, submit)
    if (chunks.length === 0) return
    if (chunks.length === 1) { this.queuePtyWrite(chunks[0]); return }

    // chunks === [body, '\r']: body now, submit Enter in its own later read.
    this.queuePtyWrite(chunks[0])
    this.submitTimer = setTimeout(() => {
      this.submitTimer = null
      if (this.disposed || this.info.state === 'exited') return
      this.queuePtyWrite('\r')
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
    // The regex is model-authored and runs synchronously: bound each line's
    // length (kills polynomial backtracking on huge lines) and the whole scan's
    // wall time so a pathological pattern degrades to a partial result instead
    // of freezing the worker's event loop (and with it every session's I/O).
    const deadline = Date.now() + SEARCH_BUDGET_MS
    for (let i = 0; i < all.length; i++) {
      if ((i & 63) === 0 && Date.now() > deadline) break
      const line = all[i].length > SEARCH_LINE_CAP ? all[i].slice(0, SEARCH_LINE_CAP) : all[i]
      if (re.test(line)) {
        totalMatches++
        for (let j = Math.max(0, i - ctx); j <= Math.min(all.length - 1, i + ctx); j++) {
          keep.add(j)
        }
      }
    }
    const picked = [...keep].sort((a, b) => a - b).map(i => `${i + 1}: ${all[i]}`)
    const { text, truncated } = capOutput(picked.join('\n'), { pagingHint: false })
    return { content: text, totalMatches, truncated }
  }

  /**
   * Block until `needle` appears in output produced AFTER this call began,
   * the session exits, or the timeout elapses. Anchoring on a baseline snapshot
   * (rather than scanning the whole buffer) prevents a stale match: text already
   * present from an earlier run — or the command echo itself — must not satisfy
   * the wait. It still catches matches that scroll off-screen between ticks,
   * since the "since baseline" diff covers the full interpreted buffer, not just
   * the viewport. Runs worker-side as one RPC so the wait never chats over IPC.
   */
  waitFor(needle: string, timeoutMs: number): Promise<TerminalWaitOutcome> {
    return new Promise((resolve) => {
      const start = Date.now()
      const baseline = this.snapshotBuffer()
      const tick = (): void => {
        if (!this.disposed && diffTail(baseline, this.renderAll()).includes(needle)) return resolve('found')
        if (this.disposed || this.info.state === 'exited') return resolve('exited')
        if (Date.now() - start >= timeoutMs) return resolve('timeout')
        setTimeout(tick, WAIT_FOR_POLL_MS)
      }
      tick()
    })
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
    this.queuePtyWrite(data)
    this.info.lastActivityAt = Date.now()
  }

  /** Raw output buffer for UI replay when a viewer attaches (xterm.write). */
  getReplayData(): string {
    return this.replayBuffer
  }

  /** Snapshot the interpreted buffer (waitFor baseline). Empty when disposed. */
  private snapshotBuffer(): string {
    return this.disposed ? '' : this.renderAll()
  }

  resize(cols: number, rows: number): void {
    if (this.disposed || this.info.state === 'exited') return
    try {
      this.proc.resize(cols, rows)
      this.term.resize(cols, rows)
      this.info.cols = cols
      this.info.rows = rows
    } catch (e) {
      console.error(`[PtyHost ${this.id}] resize failed:`, e)
    }
  }

  /**
   * Record that the AI has operated this session (via any terminal_* tool).
   * Returns true only on the first flip, so the 'touched' lifecycle event fires
   * exactly once instead of on every AI tool call.
   */
  markAiTouched(): boolean {
    if (this.info.aiTouched) return false
    this.info.aiTouched = true
    return true
  }

  get state(): TerminalRunState {
    return this.info.state
  }

  dispose(): void {
    if (this.disposed) return
    // Order matters: settle any in-flight wait (so its caller resolves instead
    // of hanging), detach the pty onData listener and mark disposed so buffered
    // output can no longer reach the xterm buffer, THEN dispose the buffer and
    // kill the process. Disposing the buffer before detaching onData would let
    // late pty output write into a disposed term (uncaught throw in a callback).
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    if (this.waitTimer) { clearTimeout(this.waitTimer); this.waitTimer = null }
    if (this.submitTimer) { clearTimeout(this.submitTimer); this.submitTimer = null }
    if (this.writeTimeout) { clearTimeout(this.writeTimeout); this.writeTimeout = null }
    this.writeQueue.length = 0
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
    // Kill synchronously where possible: the process-exit paths (shutdown /
    // disconnect / signals) call process.exit right after disposeAll, which
    // would preempt a deferred kill and leave nohup'd children to outlive us.
    // Only ConPTY defers, for its kill/spawn throttle (same conhost hang as
    // spawn) — there the ConPTY teardown on process exit reaps the children.
    if (usesConpty()) {
      void this.throttleKillSpawn().then(() => {
        try { this.proc?.kill() } catch { /* already dead */ }
      })
    } else {
      try { this.proc?.kill() } catch { /* already dead */ }
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
