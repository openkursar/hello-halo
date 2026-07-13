/**
 * Tests for AI Terminal pure text helpers.
 *
 * These drive the shell-agnostic completion heuristic and the AI-facing output
 * shaping — the correctness-critical, pty-free core of the terminal read model.
 */

import { describe, it, expect } from 'vitest'
import {
  defaultTitle,
  lastLine,
  endsAtPrompt,
  endsAtInputPrompt,
  endsAtContinuation,
  joinWrappedLines,
  trimTrailingBlank,
  diffTail,
  capOutput,
  classifyCompletion,
  safeRegExp,
  toPtyInput,
  toPtyWrites,
  MAX_RETURN_LINES,
} from '../../../../src/main/services/ai-terminal/text-utils'

describe('defaultTitle', () => {
  it('derives a clean name from a shell path', () => {
    expect(defaultTitle('/bin/zsh')).toBe('zsh')
    expect(defaultTitle('/usr/bin/bash')).toBe('bash')
  })
  it('strips .exe for Windows shells and handles backslashes', () => {
    expect(defaultTitle('C:\\Program Files\\Git\\bin\\bash.exe')).toBe('bash')
  })
  it('falls back to "shell" for empty input', () => {
    expect(defaultTitle('')).toBe('shell')
  })
})

describe('lastLine', () => {
  it('returns the last non-blank line', () => {
    expect(lastLine('a\nb\n\n  \n')).toBe('b')
  })
  it('returns empty string when all blank', () => {
    expect(lastLine('\n  \n')).toBe('')
  })
})

describe('endsAtPrompt', () => {
  it('detects common shell prompt terminators', () => {
    expect(endsAtPrompt('user@host ~ % ')).toBe(true)   // zsh
    expect(endsAtPrompt('user@host:~$ ')).toBe(true)    // bash
    expect(endsAtPrompt('root@box:/# ')).toBe(true)     // root
    expect(endsAtPrompt('PS C:\\> ')).toBe(true)        // powershell
    expect(endsAtPrompt('❯ ')).toBe(true)               // starship
  })
  it('returns false mid-command (no prompt terminator)', () => {
    // The sleep-2 case: command echoed, no prompt yet → still running.
    expect(endsAtPrompt('user@host % sleep 2 && echo done')).toBe(false)
    expect(endsAtPrompt('Downloading... 45%')).toBe(false)
  })
})

describe('endsAtInputPrompt', () => {
  it('detects interactive prompts awaiting input', () => {
    expect(endsAtInputPrompt('Proceed? [Y/n]')).toBe(true)
    expect(endsAtInputPrompt('Continue (y/n)')).toBe(true)
    expect(endsAtInputPrompt("root@host's password:")).toBe(true)
    expect(endsAtInputPrompt('Enter passphrase for key:')).toBe(true)
    expect(endsAtInputPrompt('Are you sure?')).toBe(true)
  })
  it('returns false for normal output lines', () => {
    expect(endsAtInputPrompt('total 24')).toBe(false)
    expect(endsAtInputPrompt('HTTP/1.1 200 OK')).toBe(false)
  })
})

describe('endsAtContinuation', () => {
  it('detects zsh named PS2 continuation prompts', () => {
    expect(endsAtContinuation('echo "x\ndquote>')).toBe(true)
    expect(endsAtContinuation('cat <<EOF\nheredoc>')).toBe(true)
    expect(endsAtContinuation('foo(\ncmdsubst>')).toBe(true)
  })
  it('detects a stacked zsh continuation prompt (multiple && then open quote)', () => {
    // The real S3 failure: 5x `&&` pending + an unterminated double quote.
    expect(endsAtContinuation('cmdand cmdand cmdand cmdand cmdand dquote>')).toBe(true)
  })
  it('detects a bare bash PS2 continuation', () => {
    expect(endsAtContinuation('> ')).toBe(true)
  })
  it('does not flag a settled shell prompt as continuation', () => {
    expect(endsAtContinuation('user@host ~ % ')).toBe(false)
    expect(endsAtContinuation('root@box:/# ')).toBe(false)
    expect(endsAtContinuation('PS C:\\> ')).toBe(false) // powershell prompt, not bare '>'
    expect(endsAtContinuation('Downloading... 45%')).toBe(false)
  })
})

describe('joinWrappedLines', () => {
  it('rejoins wrapped continuation rows into one logical line', () => {
    // "HTTP 500" wrapped at the column boundary → "50" + "0".
    const rows = [
      { text: 'status 50', wrapped: false },
      { text: '0', wrapped: true },
    ]
    expect(joinWrappedLines(rows)).toEqual(['status 500'])
  })
  it('keeps hard newlines (non-wrapped rows) separate', () => {
    const rows = [
      { text: 'line1', wrapped: false },
      { text: 'line2', wrapped: false },
    ]
    expect(joinWrappedLines(rows)).toEqual(['line1', 'line2'])
  })
  it('does not crash when the first row is flagged wrapped', () => {
    const rows = [{ text: 'orphan', wrapped: true }]
    expect(joinWrappedLines(rows)).toEqual(['orphan'])
  })
})

describe('trimTrailingBlank', () => {
  it('drops trailing blank lines only', () => {
    expect(trimTrailingBlank(['a', '', 'b', '', '  '])).toEqual(['a', '', 'b'])
  })
})

describe('diffTail', () => {
  it('returns full text when before is empty', () => {
    expect(diffTail('', 'hello')).toBe('hello')
  })
  it('returns the appended remainder for the common append case', () => {
    expect(diffTail('line1', 'line1\nline2')).toBe('line2')
  })
  it('falls back to line-based LCP when screen is rewritten in place', () => {
    // Progress bar rewriting the last line: shared prefix is line 0.
    const before = 'building\nprogress: 10%'
    const after = 'building\nprogress: 100%\ndone'
    expect(diffTail(before, after)).toBe('progress: 100%\ndone')
  })
  it('handles identical before/after (no new output)', () => {
    expect(diffTail('same', 'same')).toBe('')
  })

  it('returns only the new tail after scrollback eviction (not the whole buffer)', () => {
    // Simulate the buffer hitting its line cap: `before`'s leading lines are
    // evicted, everything shifts up, and new lines are appended at the bottom.
    // Neither startsWith nor line-prefix holds, but the shared region is a
    // suffix of `before` — the fix must return only the appended tail, not the
    // whole (megabyte) buffer.
    const beforeLines = Array.from({ length: 200 }, (_, i) => `line${i}`)
    const before = beforeLines.join('\n')
    // Drop the first 30 lines (evicted), keep the rest, append 3 new lines.
    const after = [...beforeLines.slice(30), 'newA', 'newB', 'newC'].join('\n')
    expect(diffTail(before, after)).toBe('newA\nnewB\nnewC')
  })

  it('anchors on the LAST occurrence of the tail block after eviction', () => {
    // The distinctive 50-line tail of `before` also appears earlier in `after`
    // (a repeated block). Anchoring on the last occurrence keeps "new" correct
    // instead of resurfacing the earlier duplicate as new output.
    const tail = Array.from({ length: 50 }, (_, i) => `t${i}`)
    const beforeLines = [...Array.from({ length: 100 }, (_, i) => `h${i}`), ...tail]
    const before = beforeLines.join('\n')
    // Evict the leading history; the tail block reappears once more, then new output.
    const after = [...tail, 'mid', ...tail, 'newX', 'newY'].join('\n')
    expect(diffTail(before, after)).toBe('newX\nnewY')
  })
})

describe('capOutput', () => {
  it('passes through small output untouched', () => {
    const { text, truncated } = capOutput('short')
    expect(text).toBe('short')
    expect(truncated).toBe(false)
  })
  it('truncates by line count and flags it with a machine-readable hint', () => {
    const many = Array.from({ length: MAX_RETURN_LINES + 50 }, (_, i) => `l${i}`).join('\n')
    const { text, truncated } = capOutput(many)
    expect(truncated).toBe(true)
    expect(text).toContain('truncated')
    // Keeps the TAIL (most recent) lines.
    expect(text).toContain(`l${MAX_RETURN_LINES + 49}`)
    expect(text).not.toContain('\nl0\n')
  })
})

describe('classifyCompletion', () => {
  it('reports a finished command at a shell prompt as done (not running, not awaiting)', () => {
    const r = classifyCompletion({
      after: 'total 24\nuser@host ~ % ',
      sawCommandEnd: false,
      lastExitCode: null,
      settledByHeuristic: true
    })
    expect(r.running).toBe(false)
    expect(r.awaitingInput).toBe(false)
  })

  it('OSC 133;D completion returns the exit code and is not "awaiting input"', () => {
    // Regression: a fresh prompt after 133;D must not be read as an input wait.
    const r = classifyCompletion({
      after: 'done\nuser@host ~ % ',
      sawCommandEnd: true,
      lastExitCode: 0,
      settledByHeuristic: false
    })
    expect(r.running).toBe(false)
    expect(r.awaitingInput).toBe(false)
    expect(r.exitCode).toBe(0)
  })

  it('does not report a stale exit code when the command did not end in this window', () => {
    // lastExitCode belongs to a previous command (e.g. before ssh to a host
    // that emits no OSC 133). It must not be attributed to the current one.
    const r = classifyCompletion({
      after: 'still working...',
      sawCommandEnd: false,
      lastExitCode: 0,
      settledByHeuristic: true
    })
    expect(r.exitCode).toBeNull()
    expect(r.running).toBe(true)
  })

  it('flags an interactive input prompt as awaitingInput (not running)', () => {
    const r = classifyCompletion({
      after: "root@host's password:",
      sawCommandEnd: false,
      lastExitCode: null,
      settledByHeuristic: true
    })
    expect(r.awaitingInput).toBe(true)
    expect(r.running).toBe(false)
  })

  it('reports a long-running command with no prompt as running', () => {
    const r = classifyCompletion({
      after: 'compiling module 42 ...',
      sawCommandEnd: false,
      lastExitCode: null,
      settledByHeuristic: true
    })
    expect(r.running).toBe(true)
    expect(r.awaitingInput).toBe(false)
    expect(r.awaitingContinuation).toBe(false)
  })

  it('flags a wedged continuation prompt as awaitingContinuation, never done/running', () => {
    // Regression: `dquote>` ends in `>` and must NOT be read as a settled prompt
    // (that misclassification let one `echo "x!"` poison the whole session).
    const r = classifyCompletion({
      after: 'echo "oops!"\ncmdand dquote>',
      sawCommandEnd: false,
      lastExitCode: null,
      settledByHeuristic: true
    })
    expect(r.awaitingContinuation).toBe(true)
    expect(r.running).toBe(false)
    expect(r.awaitingInput).toBe(false)
  })

  it('OSC 133;D completion wins over a coincidental trailing ">"', () => {
    // A real command end marker means done, even if the last line looks like PS2.
    const r = classifyCompletion({
      after: 'built >',
      sawCommandEnd: true,
      lastExitCode: 0,
      settledByHeuristic: false
    })
    expect(r.awaitingContinuation).toBe(false)
    expect(r.exitCode).toBe(0)
  })
})

describe('capOutput', () => {
  it('includes the total line count in the truncation notice', () => {
    const many = Array.from({ length: MAX_RETURN_LINES + 10 }, (_, i) => `l${i}`).join('\n')
    const { text } = capOutput(many)
    expect(text).toContain(`of ${MAX_RETURN_LINES + 10} lines`)
  })
  it('omits the read-oriented paging advice when pagingHint is false (search path)', () => {
    const many = Array.from({ length: MAX_RETURN_LINES + 10 }, (_, i) => `l${i}`).join('\n')
    const { text, truncated } = capOutput(many, { pagingHint: false })
    expect(truncated).toBe(true)
    expect(text).toContain('truncated')
    expect(text).not.toContain('scrollback')
  })
})

describe('safeRegExp', () => {
  it('is case-insensitive for an all-lowercase pattern (smart-case)', () => {
    const re = safeRegExp('error')
    expect(re.test('ERROR: boom')).toBe(true)
    expect(re.test('Error: boom')).toBe(true)
    expect(re.test('error: boom')).toBe(true)
  })
  it('is case-sensitive once the pattern contains an uppercase letter (smart-case)', () => {
    const re = safeRegExp('ValueError')
    expect(re.test('raise ValueError(x)')).toBe(true)
    expect(re.test('valueerror lowercased')).toBe(false)
  })
  it('does not let a backslash escape force case-sensitivity', () => {
    // \D is an uppercase metaclass, not a literal uppercase letter — the pattern
    // is otherwise lowercase, so it must stay case-insensitive.
    const re = safeRegExp('error\\d+')
    expect(re.test('ERROR42')).toBe(true)
  })
  it('treats an invalid regex as a literal instead of throwing', () => {
    const re = safeRegExp('a[b')  // unbalanced bracket
    expect(re.test('x a[b y')).toBe(true)
    expect(re.test('nothing')).toBe(false)
  })
  it('keeps an invalid-regex literal case-sensitive when it has uppercase', () => {
    const re = safeRegExp('A[B')  // invalid → literal, but has uppercase
    expect(re.test('x A[B y')).toBe(true)
    expect(re.test('x a[b y')).toBe(false)
  })
})

describe('toPtyInput', () => {
  it('converts a trailing LF to CR so Enter submits', () => {
    expect(toPtyInput('ls -la\n')).toBe('ls -la\r')
  })
  it('converts CRLF to a single CR (no double Enter)', () => {
    expect(toPtyInput('ls -la\r\n')).toBe('ls -la\r')
  })
  it('converts every newline in multi-line input', () => {
    expect(toPtyInput('line1\nline2\n')).toBe('line1\rline2\r')
    expect(toPtyInput('a\r\nb\nc')).toBe('a\rb\rc')
  })
  it('leaves an existing bare CR untouched', () => {
    expect(toPtyInput('done\r')).toBe('done\r')
  })
  it('passes control codes like Ctrl-C through unchanged', () => {
    expect(toPtyInput('\u0003')).toBe('\u0003')
  })
  it('is a no-op for input without newlines', () => {
    expect(toPtyInput('2')).toBe('2')
    expect(toPtyInput('')).toBe('')
  })
})

describe('toPtyWrites', () => {
  it('submits a command as body + a separate Enter (submit=true)', () => {
    // Regression: Ink TUIs (Claude Code) paste-detect a single "cmd\r" write and
    // insert a newline instead of submitting — the body and Enter must be split.
    expect(toPtyWrites('npm run build', true)).toEqual(['npm run build', '\r'])
    expect(toPtyWrites('/help', true)).toEqual(['/help', '\r'])
  })
  it('de-duplicates a caller-supplied trailing newline to a single Enter', () => {
    // "cmd" and "cmd\n" must submit identically under submit=true — the caller
    // never needs to encode a newline (the byte weak models double-escape).
    expect(toPtyWrites('npm run build\n', true)).toEqual(['npm run build', '\r'])
    expect(toPtyWrites('npm run build\r\n', true)).toEqual(['npm run build', '\r'])
  })
  it('keeps a multi-line body as one paste and splits only the final Enter', () => {
    expect(toPtyWrites('line1\nline2', true)).toEqual(['line1\rline2', '\r'])
    expect(toPtyWrites('line1\nline2\n', true)).toEqual(['line1\rline2', '\r'])
  })
  it('submits a lone Enter for empty input (submit=true)', () => {
    expect(toPtyWrites('', true)).toEqual(['\r'])
    expect(toPtyWrites('\n', true)).toEqual(['\r'])
  })
  it('sends raw keystrokes with no appended Enter when submit=false', () => {
    expect(toPtyWrites('123', false)).toEqual(['123'])
    expect(toPtyWrites('\u001b[B', false)).toEqual(['\u001b[B']) // arrow key, no confirm
    expect(toPtyWrites('\u0003', false)).toEqual(['\u0003'])      // Ctrl-C, no extra Enter
  })
  it('is empty for empty raw input (submit=false)', () => {
    expect(toPtyWrites('', false)).toEqual([])
  })
})
