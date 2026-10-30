import { opendir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import type { CcScanResult } from '../../../shared/types/cc-runtime'
import { fileExists, getRuntimeRoot, resolveCandidate } from './paths'
import { checkInstallation } from './probe'
import { CcRuntimeError } from './errors'

const MAX_LOCATIONS = 64
const MAX_INSTALLATIONS = 12

async function childDirectories(path: string, limit: number, signal: AbortSignal): Promise<{ paths: string[]; truncated: boolean }> {
  const paths: string[] = []
  try {
    const directory = await opendir(path)
    if (signal.aborted) {
      await directory.close()
      return { paths, truncated: true }
    }
    let inspected = 0
    for await (const entry of directory) {
      if (signal.aborted) return { paths, truncated: true }
      if (++inspected > 128) return { paths, truncated: true }
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      if (paths.length >= limit) return { paths, truncated: true }
      paths.push(join(path, entry.name))
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[CcRuntime] Discovery location unreadable', { code: (error as NodeJS.ErrnoException).code })
    }
  }
  return { paths, truncated: false }
}

interface DiscoveryOptions {
  signal?: AbortSignal
  stopOnCompatible?: boolean
  deadlineMs?: number
}

export async function discoverInstallations(selectedPath?: string, options: DiscoveryOptions = {}): Promise<CcScanResult> {
  const controller = new AbortController()
  const progress: CcScanResult = { installations: [], searchedLocations: 0, truncated: false }
  const snapshot = (truncated = progress.truncated): CcScanResult => ({
    installations: progress.installations.filter(Boolean).map(item => ({ ...item })),
    searchedLocations: progress.searchedLocations, truncated
  })
  const abort = () => controller.abort(options.signal?.reason ?? new CcRuntimeError('cancelled'))
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  const timeout = setTimeout(() => controller.abort(new CcRuntimeError('probe-timeout')), options.deadlineMs ?? 12_000)
  let stopped: (() => void) | undefined
  try {
    return await Promise.race([
      collectInstallations(selectedPath, { ...options, signal: controller.signal }, progress).then(() => snapshot(controller.signal.aborted || progress.truncated)),
      new Promise<CcScanResult>(resolve => {
        stopped = () => {
          console.warn('[CcRuntime] Discovery stopped; returning completed checks', {
            searched: progress.searchedLocations, completed: progress.installations.filter(Boolean).length
          })
          resolve(snapshot(true))
        }
        if (controller.signal.aborted) stopped()
        else controller.signal.addEventListener('abort', stopped, { once: true })
      })
    ])
  } finally {
    clearTimeout(timeout)
    if (stopped) controller.signal.removeEventListener('abort', stopped)
    options.signal?.removeEventListener('abort', abort)
  }
}

async function collectInstallations(selectedPath: string | undefined, options: DiscoveryOptions & { signal: AbortSignal }, progress: CcScanResult): Promise<void> {
  if (options.signal.aborted) return
  const home = homedir()
  const binary = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const paths = new Set<string>()
  if (selectedPath) paths.add(selectedPath)
  let truncated = false
  const managed = await childDirectories(getRuntimeRoot(), 12, options.signal)
  if (options.signal.aborted) return
  managed.paths.forEach(path => paths.add(join(path, binary)))
  truncated ||= managed.truncated
  const common = process.platform === 'win32'
    ? [join(home, '.local', 'bin'), process.env.APPDATA ? join(process.env.APPDATA, 'npm') : '', process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'claude') : '']
    : [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', join(home, '.npm-global', 'bin'), join(home, '.volta', 'bin')]
  for (const path of common.filter(Boolean)) {
    paths.add(join(path, binary))
    if (process.platform === 'win32') paths.add(join(path, 'claude.cmd'))
    paths.add(join(path, process.platform === 'win32' ? 'node_modules/@anthropic-ai/claude-code/cli.js' : '../lib/node_modules/@anthropic-ai/claude-code/cli.js'))
  }
  const nodeVersions = await childDirectories(join(home, '.nvm', 'versions', 'node'), 8, options.signal)
  if (options.signal.aborted) return
  nodeVersions.paths.forEach(path => paths.add(join(path, 'bin', binary)))
  truncated ||= nodeVersions.truncated
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!isAbsolute(directory)) continue
    if (paths.size >= MAX_LOCATIONS) { truncated = true; break }
    paths.add(join(directory, binary))
    if (process.platform === 'win32') paths.add(join(directory, 'claude.cmd'))
  }
  const candidates: string[] = []
  const resolved = new Set<string>()
  let invalid = 0
  for (const path of paths) {
    if (options.signal?.aborted) { truncated = true; break }
    progress.searchedLocations++
    if (!await fileExists(path)) continue
    if (options.signal.aborted) break
    if (candidates.length >= MAX_INSTALLATIONS) { truncated = true; break }
    try {
      const candidate = await resolveCandidate(path)
      if (options.signal.aborted) break
      if (resolved.has(candidate.resolvedPath)) continue
      resolved.add(candidate.resolvedPath)
      candidates.push(candidate.path)
    } catch { invalid++ }
  }
  const installations = progress.installations
  let next = 0
  let foundCompatible = false
  await Promise.all(Array.from({ length: Math.min(options.stopOnCompatible ? 1 : 3, candidates.length) }, async () => {
    while (next < candidates.length && !options.signal?.aborted && !foundCompatible) {
      const index = next++
      const result = await checkInstallation(candidates[index], { signal: options.signal })
      if (options.signal.aborted) break
      installations[index] = result
      if (options.stopOnCompatible && ['verified', 'compatible'].includes(installations[index].compatibility)) foundCompatible = true
    }
  }))
  if (options.signal?.aborted) truncated = true
  progress.truncated = truncated
  if (!options.signal.aborted) console.log('[CcRuntime] Bounded discovery completed', { searched: progress.searchedLocations, found: installations.length, invalid, truncated })
}
