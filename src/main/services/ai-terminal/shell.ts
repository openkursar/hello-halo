/**
 * AI Terminal - Shell resolution
 *
 * Resolves the default interactive shell per platform.
 *
 * Command-completion strategy: we do NOT inject prompt hacks into the user's
 * shell. Per-shell PS1/PROMPT_COMMAND rewriting is fragile (quoting differs
 * across bash/zsh/fish, breaks under ConPTY, mangles custom prompts) and would
 * pollute the very screen the AI reads. Instead the session detects command
 * boundaries with a shell-agnostic output-idle heuristic — the same mechanism
 * the remote/SSH path needs anyway.
 *
 * OSC 133 markers are still PARSED opportunistically (session.ts registers the
 * handler): if a shell or remote host already emits them, we get precise
 * boundaries + exit codes for free. We just never inject them ourselves.
 */

import { platform } from 'os'
import { detectGitBash } from '../git-bash.service'

/** Shell family, used to decide which one-time hardening a session may apply. */
export type ShellFamily = 'posix' | 'other'

export interface ResolvedShell {
  file: string
  args: string[]
  /** Extra env layered onto the pty environment */
  env: Record<string, string>
  /** posix = bash/zsh/sh family (accepts `set -o`); other = powershell/cmd/… */
  family: ShellFamily
}

/**
 * Resolve the shell to spawn. An explicit `preferred` executable wins and
 * receives neutral interactive args for its own family; otherwise the platform
 * default is used.
 */
export function resolveShell(preferred?: string): ResolvedShell {
  const env = { HALO_TERMINAL: '1' }

  // An explicit choice must get args matching THAT executable — never staple
  // git-bash's `--login -i` onto e.g. powershell.exe (different arg grammar).
  if (preferred) {
    return { file: preferred, args: interactiveArgs(preferred), env, family: shellFamily(preferred) }
  }

  if (platform() === 'win32') {
    // Reuse Git Bash so the Unix-shell system prompt holds (forward slashes,
    // /dev/null, etc.). ConPTY drives the pty (node-pty default).
    const gitBash = detectGitBash()
    if (gitBash.found && gitBash.path) {
      return { file: gitBash.path, args: ['--login', '-i'], env, family: 'posix' }
    }
    // Fallback: PowerShell.
    return { file: 'powershell.exe', args: [], env, family: 'other' }
  }

  // Interactive shell so the user's normal prompt/aliases load.
  const file = process.env.SHELL || '/bin/bash'
  return { file, args: ['-i'], env, family: shellFamily(file) }
}

/**
 * Classify a shell executable. Only the bash/zsh/sh family accepts `set -o`
 * option toggling (used for one-time session hardening). `pwsh` ends in "sh"
 * but is PowerShell, so it is matched explicitly and excluded.
 */
export function shellFamily(file: string): ShellFamily {
  const base = (file.split(/[\\/]/).pop() || '').toLowerCase().replace(/\.exe$/, '')
  if (base === 'pwsh' || base === 'powershell' || base === 'cmd') return 'other'
  if (/^(?:bash|zsh|sh|dash|ksh|ash|mksh)$/.test(base)) return 'posix'
  return 'other'
}

/** Interactive-shell args by executable family. */
function interactiveArgs(file: string): string[] {
  const base = file.toLowerCase()
  if (
    base.endsWith('powershell.exe') || base.endsWith('pwsh.exe') ||
    base.endsWith('pwsh') || base.endsWith('cmd.exe')
  ) {
    return []
  }
  return ['-i']
}
