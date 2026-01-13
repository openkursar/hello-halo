/**
 * Git Bash Service - Detection and path management for Windows
 *
 * Claude Code CLI on Windows requires Git Bash as the shell execution environment.
 * This service detects existing Git Bash installations and manages paths.
 */

import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

export interface GitBashDetectionResult {
  found: boolean
  path: string | null
  source: 'system' | 'app-local' | 'env-var' | null
}

/**
 * Detect Git Bash installation on the system
 *
 * Detection order:
 * 1. Environment variable (CLAUDE_CODE_GIT_BASH_PATH)
 * 2. App-local installation (userData/git-bash)
 * 3. System installation (Program Files)
 * 4. PATH-based discovery
 */
export function detectGitBash(): GitBashDetectionResult {
  // Non-Windows platforms use system bash
  if (process.platform !== 'win32') {
    return { found: true, path: '/bin/bash', source: 'system' }
  }

  // 1. Check environment variable
  const envPath = process.env.CLAUDE_CODE_GIT_BASH_PATH
  if (envPath && existsSync(envPath)) {
    console.log('[GitBash] Found via environment variable:', envPath)
    return { found: true, path: envPath, source: 'env-var' }
  }

  // 2. Check app-local installation (managed by Halo)
  const localGitBash = join(app.getPath('userData'), 'git-bash', 'bin', 'bash.exe')
  if (existsSync(localGitBash)) {
    console.log('[GitBash] Found app-local installation:', localGitBash)
    return { found: true, path: localGitBash, source: 'app-local' }
  }

  // 3. Check system installation paths
  const systemPaths = [
    join(process.env.PROGRAMFILES || '', 'Git', 'bin', 'bash.exe'),
    join(process.env['PROGRAMFILES(X86)'] || '', 'Git', 'bin', 'bash.exe'),
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe'
  ]

  for (const p of systemPaths) {
    if (p && existsSync(p)) {
      console.log('[GitBash] Found system installation:', p)
      return { found: true, path: p, source: 'system' }
    }
  }

  // 4. Try to find git in PATH and derive bash path
  const gitFromPath = findGitInPath()
  if (gitFromPath) {
    // Git is typically at: C:\Program Files\Git\cmd\git.exe
    // Bash is at: C:\Program Files\Git\bin\bash.exe
    const bashPath = join(gitFromPath, '..', '..', 'bin', 'bash.exe')
    if (existsSync(bashPath)) {
      console.log('[GitBash] Found via PATH:', bashPath)
      return { found: true, path: bashPath, source: 'system' }
    }
  }

  console.log('[GitBash] Not found')
  return { found: false, path: null, source: null }
}

/**
 * Find git.exe in PATH environment variable
 */
function findGitInPath(): string | null {
  const pathEnv = process.env.PATH || ''
  const paths = pathEnv.split(';')

  for (const p of paths) {
    const gitExe = join(p, 'git.exe')
    if (existsSync(gitExe)) {
      return gitExe
    }
  }
  return null
}

/**
 * Get the path to the app-local Git Bash installation directory
 */
export function getAppLocalGitBashDir(): string {
  return join(app.getPath('userData'), 'git-bash')
}

/**
 * Check if Git Bash is installed by Halo (app-local)
 */
export function isAppLocalInstallation(): boolean {
  const result = detectGitBash()
  return result.found && result.source === 'app-local'
}

/**
 * Set the Git Bash path environment variable for Claude Code SDK
 */
export function setGitBashPathEnv(path: string): void {
  process.env.CLAUDE_CODE_GIT_BASH_PATH = path
  console.log('[GitBash] Environment variable set:', path)
}
