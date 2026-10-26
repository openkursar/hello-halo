import { constants } from 'node:fs'
import { access, open, realpath, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { homedir } from 'node:os'
import { getHaloDir } from '../../foundation/config.service'
import type { CcRuntimeLaunch } from '../../../shared/types/cc-runtime'
import { CcRuntimeError } from './errors'

export function getRuntimeRoot(): string {
  return join(getHaloDir(), 'runtimes', 'claude-code')
}

export async function isManagedPath(path: string): Promise<boolean> {
  let root: string
  try { root = await realpath(getRuntimeRoot()) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[CcRuntime] Managed directory cannot be resolved', { code: (error as NodeJS.ErrnoException).code })
    return false
  }
  const local = relative(root, path)
  return local !== '' && !local.startsWith(`..${sep}`) && local !== '..' && !isAbsolute(local)
}

export function normalizeInputPath(input: string): string {
  if (typeof input !== 'string' || input.length > 4096) throw new CcRuntimeError('not-found')
  const trimmed = input.trim().replace(/^(["'])(.*)\1$/, '$2')
  const path = trimmed === '~' ? homedir() : trimmed.startsWith(`~${sep}`) || trimmed.startsWith('~/')
    ? join(homedir(), trimmed.slice(2)) : trimmed
  if (!path || path.includes('\0') || !isAbsolute(path)) throw new CcRuntimeError('not-found')
  return normalize(path)
}

export async function fileExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile() } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') {
      console.warn('[CcRuntime] Candidate cannot be inspected', { code: (error as NodeJS.ErrnoException).code })
    }
    return false
  }
}

export async function resolveCandidatePath(input: string): Promise<string> {
  const path = normalizeInputPath(input)
  let info
  try { info = await stat(path) } catch { throw new CcRuntimeError('not-found') }
  if (info.isDirectory()) {
    const names = process.platform === 'win32' ? ['claude.exe', 'bin/claude.exe'] : ['claude', 'bin/claude']
    for (const name of [...names, 'bin/claude.exe', 'cli.js', 'node_modules/@anthropic-ai/claude-code/cli.js', 'lib/node_modules/@anthropic-ai/claude-code/cli.js', 'node_modules/@anthropic-ai/claude-code/bin/claude.exe', 'lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe']) {
      const candidate = join(path, name)
      if (await fileExists(candidate)) return candidate
    }
    throw new CcRuntimeError('not-found')
  }
  if (!info.isFile()) throw new CcRuntimeError('not-executable')
  if (['.cmd', '.bat', '.ps1'].includes(extname(path).toLowerCase())) {
    const candidates = [join(dirname(path), 'node_modules/@anthropic-ai/claude-code/bin/claude.exe'), join(dirname(path), 'node_modules/@anthropic-ai/claude-code/cli.js')]
    for (const candidate of candidates) if (await fileExists(candidate)) return candidate
    throw new CcRuntimeError('unsupported-launcher')
  }
  return path
}

export interface ResolvedCandidate {
  path: string
  resolvedPath: string
  stamp: string
  launch: Omit<CcRuntimeLaunch, 'version'>
}

export async function resolveCandidate(input: string): Promise<ResolvedCandidate> {
  const path = await resolveCandidatePath(input)
  const resolvedPath = await realpath(path)
  const info = await stat(resolvedPath)
  const handle = await open(resolvedPath, 'r')
  let header: Buffer
  try {
    header = Buffer.alloc(256)
    const read = await handle.read(header, 0, header.length, 0)
    header = header.subarray(0, read.bytesRead)
  } finally { await handle.close() }
  const isJavascript = ['.js', '.mjs', '.cjs'].includes(extname(resolvedPath)) || /^#![^\n]*\b(?:node|bun)\b/.test(header.toString('utf8'))
  const magic = header.length >= 4 ? header.readUInt32BE(0) : 0
  const isNative = [0x7f454c46, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic) || header.subarray(0, 2).toString() === 'MZ'
  if (!isJavascript && !isNative) throw new CcRuntimeError('unsupported-launcher')
  if (!isJavascript && process.platform !== 'win32') {
    try { await access(resolvedPath, constants.X_OK) } catch { throw new CcRuntimeError('not-executable') }
  }
  const env: Record<string, string> = { DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1' }
  if (isJavascript) env.ELECTRON_RUN_AS_NODE = '1'
  return {
    path, resolvedPath,
    stamp: `${resolvedPath}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`,
    launch: {
      command: isJavascript ? process.execPath : resolvedPath,
      argsPrefix: isJavascript ? [resolvedPath] : [],
      env, path, kind: isJavascript ? 'javascript' : 'native'
    }
  }
}
