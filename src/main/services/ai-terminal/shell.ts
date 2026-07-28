/**
 * AI Terminal - Shell resolution (policy; runs in the main process)
 *
 * Resolves the default interactive shell per platform into a ResolvedShellSpec
 * the pty-host worker can execute verbatim. Kept in main because policy may
 * consult main-only facilities; the worker never decides which shell to run.
 *
 * Windows default is PowerShell — the standard default shell on Windows. It
 * matters beyond familiarity: `ssh` then resolves to the native Windows OpenSSH
 * (System32), not Git Bash's MSYS ssh, whose emulated socket layer breaks
 * inside VDI virtual-network stacks (10s disconnect + wedged raw mode); and
 * PowerShell starts as a single process, unlike Git Bash `--login` whose MSYS
 * init forks dozens of processes (10s+ open time under endpoint scanning).
 * Git Bash remains reachable via an explicit `preferred` path.
 *
 * Command-completion strategy: we do NOT inject prompt hacks into the user's
 * shell. Per-shell PS1/PROMPT_COMMAND rewriting is fragile (quoting differs
 * across bash/zsh/fish, breaks under ConPTY, mangles custom prompts) and would
 * pollute the very screen the AI reads. Instead the session detects command
 * boundaries with a shell-agnostic output-idle heuristic — the same mechanism
 * the remote/SSH path needs anyway.
 *
 * OSC 133 markers are still PARSED opportunistically (worker session registers
 * the handler): if a shell or remote host already emits them, we get precise
 * boundaries + exit codes for free. We just never inject them ourselves.
 */

import { platform } from 'os'
import type { ResolvedShellSpec, ShellFamily } from '../../../shared/types/terminal'

export type { ResolvedShellSpec, ShellFamily }

/**
 * Resolve the shell to spawn. An explicit `preferred` executable wins and
 * receives neutral interactive args for its own family; otherwise the platform
 * default is used.
 */
export function resolveShell(preferred?: string): ResolvedShellSpec {
  const env = { HALO_TERMINAL: '1' }

  // An explicit choice must get args matching THAT executable — never staple
  // one shell family's args onto another (different arg grammar).
  if (preferred) {
    return { file: preferred, args: interactiveArgs(preferred), env, family: shellFamily(preferred) }
  }

  if (platform() === 'win32') {
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
