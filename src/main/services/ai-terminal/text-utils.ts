/**
 * AI Terminal - Pure text helpers
 *
 * Extracted from session.ts so the completion heuristics and output shaping can
 * be unit-tested in isolation (no pty / xterm dependency).
 */

/** Harness hard cap per read/write return (rough line + byte guard) */
export const MAX_RETURN_LINES = 2000
export const MAX_RETURN_BYTES = 50_000

export function defaultTitle(shellFile: string): string {
  const base = shellFile.split(/[\\/]/).pop() || 'shell'
  return base.replace(/\.exe$/i, '')
}

/** Last non-blank line of the rendered buffer. */
export function lastLine(rendered: string): string {
  const lines = rendered.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') return lines[i]
  }
  return ''
}

/**
 * Heuristic: does the buffer end at an idle shell prompt awaiting a command?
 * Matches common prompt terminators ($, #, >, and fancy prompt glyphs).
 *
 * `%` (the zsh prompt char) is special-cased: it only counts as a prompt when
 * preceded by whitespace (e.g. "host %"), never when it terminates a token like
 * a progress percentage ("Downloading... 45%"). xterm strips trailing spaces
 * from each rendered line, so we cannot rely on a trailing space to tell them
 * apart. False negatives are safe (a finished command just looks "running" and
 * the AI polls once more); false positives would truncate a live command.
 */
export function endsAtPrompt(rendered: string): boolean {
  const line = lastLine(rendered)
  return /(\s%|[$#>»›❯])\s*$/.test(line)
}

/**
 * Heuristic: does the buffer end at an interactive input prompt (a question
 * without a trailing newline), e.g. "[Y/n]", "Password:", "Continue?".
 */
export function endsAtInputPrompt(rendered: string): boolean {
  const line = lastLine(rendered).trim()
  return /(\[y\/n\]|\(y\/n\)|password.*:|passphrase.*:|\?\s*$|:\s*$)/i.test(line)
}

/**
 * Heuristic: is the shell wedged at a line-continuation prompt, waiting for the
 * rest of an incomplete command (an unterminated quote, an open here-doc body,
 * a dangling `&&`, etc.)? This is NOT completion and NOT interactive input — the
 * shell parser is mid-statement and will swallow the next command as more of the
 * same statement, cascading corruption.
 *
 * Critical distinction from endsAtPrompt: zsh continuation prompts end in `>`
 * (e.g. "dquote>", or a stacked "cmdand cmdand dquote>"), which the generic
 * prompt-terminator test would otherwise misread as a settled `>` prompt and
 * report as "done" — the exact bug that let one `echo "x!"` poison a session.
 *
 * zsh emits named PS2 tokens (matched below). bash's default PS2 is a bare `>`;
 * a finished bash command returns to `$`/`#`, never a lone `>`, so treating a
 * standalone `>` as continuation is safe in practice (custom prompts that are
 * literally `>` are the rare, self-recoverable exception).
 */
const ZSH_CONTINUATION_TOKEN =
  /^(?:\w+ )*(?:quote|dquote|bquote|cmdsubst|mathsubst|heredoc|heredocsubst|cmdand|cmdor|pipe|pipequote|subsh|array|newline|forloop|whileloop|untilloop|caseloop|then|else|elif|do)>$/
export function endsAtContinuation(rendered: string): boolean {
  const line = lastLine(rendered).trim()
  if (line === '>') return true
  return ZSH_CONTINUATION_TOKEN.test(line)
}

/**
 * Rejoin physically-wrapped rows into logical lines.
 *
 * A headless xterm buffer stores hard-wrapped rows: a command line (or output
 * line) longer than the terminal width occupies multiple rows, and every
 * continuation row is flagged `wrapped`. Emitting one `\n` per physical row is
 * what split "HTTP 500" into "50\n0" and chopped long echoed commands. Rejoining
 * wrapped rows restores the logical line the shell actually saw/printed.
 */
export function joinWrappedLines(rows: { text: string; wrapped: boolean }[]): string[] {
  const out: string[] = []
  for (const row of rows) {
    if (row.wrapped && out.length > 0) out[out.length - 1] += row.text
    else out.push(row.text)
  }
  return out
}

/**
 * Classify how a write-and-wait settled, from the rendered buffer and markers.
 * Pure so the state machine can be unit-tested without a pty:
 *  - awaitingContinuation: the shell is wedged mid-statement at a PS2
 *    continuation prompt (unterminated quote / open here-doc / dangling `&&`).
 *    Checked FIRST because zsh continuation prompts end in `>` and would
 *    otherwise be misread as a settled prompt (see endsAtContinuation).
 *  - atPrompt (finished): OSC 133;D fired (sawCommandEnd) or the buffer ends at
 *    a shell prompt.
 *  - awaitingInput: went quiet mid-command at an interactive input prompt
 *    (password / [Y/n] / "Continue?"). A finished command at a fresh shell
 *    prompt is NOT this — hence it requires !atPrompt.
 *  - running: went quiet/timed out mid-command with no prompt of any kind.
 * exitCode is reported only for a command that ended in THIS window; otherwise
 * lastExitCode belongs to an earlier command and is stale.
 */
export function classifyCompletion(opts: {
  after: string
  sawCommandEnd: boolean
  lastExitCode: number | null
  settledByHeuristic: boolean
}): { running: boolean; awaitingInput: boolean; awaitingContinuation: boolean; exitCode: number | null } {
  const awaitingContinuation = !opts.sawCommandEnd && endsAtContinuation(opts.after)
  const atPrompt = !awaitingContinuation && (opts.sawCommandEnd || endsAtPrompt(opts.after))
  const awaitingInput = !awaitingContinuation && !atPrompt && endsAtInputPrompt(opts.after)
  const running = !awaitingContinuation && !atPrompt && !awaitingInput && opts.settledByHeuristic
  return {
    running,
    awaitingInput,
    awaitingContinuation,
    exitCode: opts.sawCommandEnd ? opts.lastExitCode : null
  }
}

export function trimTrailingBlank(lines: string[]): string[] {
  let end = lines.length
  while (end > 0 && lines[end - 1].trim() === '') end--
  return lines.slice(0, end)
}

/** Lines of `before`'s tail used to re-anchor `after` after scrollback eviction. */
const DIFF_ANCHOR_LINES = 40

/**
 * Return the tail of `after` that is new relative to `before`.
 *
 * Three cases, in order:
 *  1. `after` starts with `before` (the common append case) → return the remainder.
 *  2. `before` is a line-level prefix of `after` → return the lines beyond it.
 *  3. Scrollback eviction: once the buffer hits its line cap, appending new
 *     output drops leading lines, so `before`'s lines shift and neither prefix
 *     test holds. Naively returning `after` from the first differing line would
 *     dump the whole buffer (megabytes, all "new") on every read. Instead anchor
 *     on the tail block of `before` and return only what follows its last
 *     occurrence in `after`. If no anchor is found (screen fully rewritten, e.g.
 *     a progress bar or TUI), fall back to the tail beyond the shared prefix.
 */
export function diffTail(before: string, after: string): string {
  if (!before) return after
  if (after.startsWith(before)) {
    return after.slice(before.length).replace(/^\n/, '')
  }
  const b = before.split('\n')
  const a = after.split('\n')
  // Line-level common prefix (append-only, no eviction).
  let i = 0
  while (i < b.length && i < a.length && b[i] === a[i]) i++
  if (i === b.length) return a.slice(i).join('\n')

  // Eviction case: the shared region is a suffix of `before` sitting inside
  // `after`. Anchor on `before`'s trailing block; new output is whatever follows
  // its last occurrence.
  const anchor = b.slice(Math.max(0, b.length - DIFF_ANCHOR_LINES))
  const at = lastBlockIndex(a, anchor)
  if (at >= 0) return a.slice(at + anchor.length).join('\n')

  // No shared anchor (in-place rewrite): tail beyond the shared prefix.
  return a.slice(i).join('\n')
}

/** Start index of the last contiguous occurrence of `needle` in `hay`, or -1. */
function lastBlockIndex(hay: string[], needle: string[]): number {
  if (needle.length === 0 || needle.length > hay.length) return -1
  for (let start = hay.length - needle.length; start >= 0; start--) {
    let matched = true
    for (let k = 0; k < needle.length; k++) {
      if (hay[start + k] !== needle[k]) { matched = false; break }
    }
    if (matched) return start
  }
  return -1
}

/**
 * Hard-cap a return to the harness line/byte budget, keeping the tail (most
 * recent) and prefixing a machine-readable truncation notice.
 *
 * `pagingHint` (default true) appends the read-oriented "page earlier output
 * with scrollback offset" advice — right for reads, wrong for a search result
 * (where the fix is to narrow the pattern, not page). terminal_search passes
 * false and supplies its own hint in the tool header.
 */
export function capOutput(
  text: string,
  opts: { pagingHint?: boolean } = {}
): { text: string; truncated: boolean } {
  let out = text
  let truncated = false
  const totalLines = out.split('\n').length
  const lines = out.split('\n')
  if (lines.length > MAX_RETURN_LINES) {
    out = lines.slice(lines.length - MAX_RETURN_LINES).join('\n')
    truncated = true
  }
  if (out.length > MAX_RETURN_BYTES) {
    out = out.slice(out.length - MAX_RETURN_BYTES)
    truncated = true
  }
  if (truncated) {
    const advice = opts.pagingHint !== false
      ? `; use terminal_read(mode:'scrollback', offset:...) for earlier output`
      : ''
    out = `[...truncated to the last ${MAX_RETURN_LINES} of ${totalLines} lines${advice}]\n${out}`
  }
  return { text: out, truncated }
}

/**
 * Translate newlines in AI-supplied input into carriage returns before it is
 * written to the pty.
 *
 * A real terminal transmits CR (`\r`, 0x0D) when the user presses Return — never
 * LF (`\n`, 0x0A). Cooked-mode shells tolerate a bare LF (their line discipline
 * accepts it as the canonical line terminator), which is why sending "cmd\n"
 * appears to work for ordinary commands. But raw-mode TUIs (Claude Code, Codex,
 * vim, less, …) parse keystrokes themselves and recognise Enter only as CR; a
 * bare LF is treated as a literal newline / Ctrl-J and never submits. Because
 * the AI naturally ends its input with "\n", without this translation it can
 * type into such an app but never actually send — the reported "input becomes
 * characters, nothing submits" bug.
 *
 * Rewriting CRLF and lone LF to CR makes injected input byte-identical to a
 * human pressing Return, for both shell and TUI targets. All other bytes —
 * including deliberate control codes like `\u0003` (Ctrl-C) — pass through
 * untouched.
 */
export function toPtyInput(input: string): string {
  return input.replace(/\r\n|\n/g, '\r')
}

/**
 * Split AI input into the ordered pty writes that reproduce a human typing it.
 *
 * Applies {@link toPtyInput} (LF→CR). When `submit` is true, any trailing newline
 * the caller included is stripped and replaced with a single canonical Enter (CR)
 * peeled into its own chunk — so "claude" and "claude\n" behave identically and
 * both submit, and the caller never has to encode a newline (the layer weak models
 * most often double-escape into a literal "\n"). When `submit` is false the bytes
 * are returned as-is with no Enter appended, for raw keystrokes (an arrow key, Esc,
 * a menu digit) that must not confirm.
 *
 * The Enter is peeled into its own chunk because Ink-based TUIs (Claude Code,
 * Codex) paste-detect a single write carrying text-then-CR and insert a newline
 * instead of submitting; a human types the body and presses Return separately. A
 * multi-line body stays one paste and only the trailing Enter submits. Returns
 * 0–2 chunks; the caller writes them in order.
 */
export function toPtyWrites(input: string, submit: boolean): string[] {
  const data = toPtyInput(input)
  if (!submit) return data ? [data] : []
  const body = data.replace(/\r+$/, '')
  return body ? [body, '\r'] : ['\r']
}

/**
 * Build a case-smart regex for terminal_search.
 *
 * Smart-case (the ripgrep/less convention): case-insensitive while the pattern
 * is all-lowercase, case-sensitive as soon as it contains an uppercase letter —
 * so `error` matches ERROR/Error/error, while `ValueError` matches only that
 * exact casing. It covers both intents with zero extra parameters, so the AI
 * never has to decide a case flag per search. Backslash escapes (`\D`, `\S`,
 * `\b`, …) are stripped before the decision so a metaclass never silently forces
 * case-sensitivity. Invalid regex falls back to a literal match, still case-smart.
 */
export function safeRegExp(pattern: string): RegExp {
  const flags = /[A-Z]/.test(pattern.replace(/\\./g, '')) ? '' : 'i'
  try {
    return new RegExp(pattern, flags)
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
  }
}
