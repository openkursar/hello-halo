import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Mirrors scripts/lib/ripgrep.cjs, which build tooling reads; a test keeps them in step. */
export const RIPGREP_PACKAGES: Readonly<Record<string, string>> = {
  'darwin-arm64': '@vscode/ripgrep-darwin-arm64',
  'darwin-x64': '@vscode/ripgrep-darwin-x64',
  'win32-x64': '@vscode/ripgrep-win32-x64',
  'linux-x64': '@vscode/ripgrep-linux-x64',
}

let resolved: string | null | undefined

/**
 * The ripgrep shipped for the Halo SDK engine's Grep tool, or null when this
 * build has none (Grep then uses an `rg` on PATH). Packaged builds point at the
 * unpacked copy: a spawned binary cannot run from inside the archive.
 */
export function getBundledRipgrepPath(): string | null {
  if (resolved !== undefined) return resolved
  const key = `${process.platform}-${process.arch}`
  const packageName = RIPGREP_PACKAGES[key]
  const appPath = app.getAppPath()
  const root = app.isPackaged ? appPath.replace(/\.asar$/, '.asar.unpacked') : appPath
  const candidate = packageName
    ? join(root, 'node_modules', ...packageName.split('/'), 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg')
    : null
  resolved = candidate && existsSync(candidate) ? candidate : null
  if (!resolved) console.warn(`[Agent][Halo] Bundled ripgrep not found for ${key}; Grep will use rg from PATH`, { candidate })
  return resolved
}
