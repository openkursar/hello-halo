import { spawn } from 'node:child_process'
import { setMaxListeners } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CcInstallation, CcRuntimeLaunch } from '../../../shared/types/cc-runtime'
import { CcRuntimeError, issueFromError } from './errors'
import { compareVersion, isRecommendedVersion, isVerifiedRuntime, MINIMUM_VERSION } from './policy'
import { isManagedPath, normalizeInputPath, resolveCandidate, type ResolvedCandidate } from './paths'

const MAX_OUTPUT = 1024 * 1024
const PROBE_TIMEOUT_MS = 20_000
const CACHE_CAPACITY = 24
interface ProbeCacheEntry {
  stamp: string
  result: CcInstallation
  launch?: CcRuntimeLaunch
  expires: number
}
const probeCache = new Map<string, ProbeCacheEntry>()
const pendingProbes = new Map<string, Promise<CcInstallation>>()
const runningChecks = new Set<Promise<CcInstallation>>()
const shutdownController = new AbortController()
setMaxListeners(CACHE_CAPACITY + 8, shutdownController.signal)
let activeProbes = 0
const probeWaiters: Array<() => void> = []

function abortError(signal?: AbortSignal): CcRuntimeError {
  return signal?.reason instanceof CcRuntimeError && signal.reason.code === 'probe-timeout'
    ? signal.reason : new CcRuntimeError('cancelled')
}

async function acquireProbeSlot(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) throw abortError(signal)
  if (activeProbes >= 3) {
    if (probeWaiters.length >= CACHE_CAPACITY) throw new CcRuntimeError('probe-busy')
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }
      const abort = () => {
        const index = probeWaiters.indexOf(start)
        if (index !== -1) probeWaiters.splice(index, 1)
        reject(abortError(signal))
      }
      probeWaiters.push(start)
      signal?.addEventListener('abort', abort, { once: true })
    })
  } else activeProbes++
  return () => {
    const next = probeWaiters.shift()
    if (next) next()
    else activeProbes--
  }
}

function putCache(key: string, entry: ProbeCacheEntry): void {
  probeCache.delete(key)
  probeCache.set(key, entry)
  while (probeCache.size > CACHE_CAPACITY) probeCache.delete(probeCache.keys().next().value!)
}

function probeEnvironment(directory: string, launch: ResolvedCandidate['launch']): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: directory, USERPROFILE: directory, TMPDIR: directory, TMP: directory, TEMP: directory,
    XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, XDG_DATA_HOME: directory,
    APPDATA: directory, LOCALAPPDATA: directory,
    CLAUDE_CONFIG_DIR: directory, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: 'localhost,127.0.0.1',
    ...launch.env
  }
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'CLAUDE_CODE_GIT_BASH_PATH']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return env
}

async function runProbe(
  candidate: ResolvedCandidate,
  directory: string,
  handshake: boolean,
  signal?: AbortSignal
): Promise<string> {
  if (signal?.aborted) throw abortError(signal)
  return new Promise((resolve, reject) => {
    const args = handshake ? [
      '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-prompt-tool', 'stdio', '--setting-sources', '', '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}', '--settings', '{"disableAllHooks":true}', '--no-session-persistence'
    ] : ['--version']
    const child = spawn(candidate.launch.command, [...candidate.launch.argsPrefix, ...args], {
      cwd: directory, env: probeEnvironment(directory, candidate.launch), windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let output = ''
    let buffer = ''
    let bytes = 0
    let controlIndex = 0
    const controls = [
      { subtype: 'initialize', hooks: {}, sdkMcpServers: [] },
      { subtype: 'set_permission_mode', mode: 'default' },
      { subtype: 'cancel_async_message', message_uuid: '00000000-0000-4000-8000-000000000000' },
      { subtype: 'set_max_thinking_tokens', max_thinking_tokens: 0 }
    ]
    const sendControl = () => child.stdin.write(JSON.stringify({ type: 'control_request', request_id: `halo-probe-${controlIndex}`, request: controls[controlIndex] }) + '\n')
    let done = false
    let settled = false
    let malformedLines = 0
    let outcome: { value?: string; error?: CcRuntimeError } | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: CcRuntimeError, value?: string) => {
      if (done) return
      done = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      outcome = { error, value }
      if (malformedLines) console.warn('[CcRuntime] Probe ignored malformed output', { count: malformedLines })
      child.stdin.end()
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) settle()
      else {
        child.kill('SIGTERM')
        killTimer = setTimeout(() => child.kill('SIGKILL'), 1000)
        killTimer.unref()
      }
    }
    const settle = () => {
      if (settled) return
      settled = true
      if (killTimer) clearTimeout(killTimer)
      child.stdout.destroy()
      child.stderr.destroy()
      if (outcome?.error) reject(outcome.error)
      else resolve(outcome?.value || '')
    }
    const timeout = setTimeout(() => finish(new CcRuntimeError('probe-timeout')), PROBE_TIMEOUT_MS)
    const abort = () => finish(abortError(signal))
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', () => finish(new CcRuntimeError('process-failed')))
    child.on('exit', () => { if (done) settle() })
    child.stdin.on('error', () => { if (!done) finish(new CcRuntimeError('process-failed')) })
    child.on('close', (code) => {
      if (done) { settle(); return }
      finish(code === 0 && !handshake ? undefined : new CcRuntimeError('process-failed'), output)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_OUTPUT) finish(new CcRuntimeError('process-failed'))
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (done) return
      bytes += chunk.length
      if (bytes > MAX_OUTPUT) { finish(new CcRuntimeError('process-failed')); return }
      if (!handshake) { output += chunk.toString('utf8'); return }
      buffer += chunk.toString('utf8')
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let message
        try { message = JSON.parse(line) } catch { malformedLines++; continue }
        if (message?.type !== 'control_response') continue
        const response = message.response
        if (response?.request_id !== `halo-probe-${controlIndex}`) continue
        if (response.subtype !== 'success') { finish(new CcRuntimeError('protocol-unsupported')); return }
        if (controlIndex === 0) {
          if (!Array.isArray(response.response?.commands) || !Array.isArray(response.response?.models)) {
            finish(new CcRuntimeError('protocol-unsupported')); return
          }
        }
        if (controlIndex === 2 && response.response?.cancelled !== false) {
          finish(new CcRuntimeError('protocol-unsupported')); return
        }
        if (++controlIndex === controls.length) { finish(undefined, 'ready'); return }
        sendControl()
      }
    })
    if (handshake) sendControl()
    else child.stdin.end()
  })
}

async function inspect(candidate: ResolvedCandidate, signal?: AbortSignal): Promise<CcInstallation> {
  const result: CcInstallation = {
    path: candidate.path, resolvedPath: candidate.resolvedPath, kind: candidate.launch.kind,
    managed: await isManagedPath(candidate.resolvedPath), compatibility: 'unavailable',
    recommended: false, checkedAt: new Date().toISOString()
  }
  let directory: string | undefined
  let release: (() => void) | undefined
  try {
    release = await acquireProbeSlot(signal)
    directory = await mkdtemp(join(tmpdir(), 'halo-cc-probe-'))
    const output = await runProbe(candidate, directory, false, signal)
    const match = output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*\(Claude Code\)/)
    if (!match) throw new CcRuntimeError('version-unrecognized')
    result.version = match[1]
    result.recommended = isRecommendedVersion(result.version)
    if (compareVersion(result.version, MINIMUM_VERSION) < 0) throw new CcRuntimeError('version-too-old')
    await runProbe(candidate, directory, true, signal)
    result.compatibility = isVerifiedRuntime(result.version, candidate.launch.kind) ? 'verified' : 'compatible'
  } catch (error) {
    result.issue = issueFromError(error, 'process-failed')
    result.compatibility = ['version-too-old', 'version-unrecognized', 'protocol-unsupported'].includes(result.issue) ? 'incompatible' : 'unavailable'
    console.warn('[CcRuntime] Compatibility probe did not pass', { kind: result.kind, version: result.version, issue: result.issue })
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(error => console.warn('[CcRuntime] Probe directory cleanup failed', { code: (error as NodeJS.ErrnoException).code }))
    release?.()
  }
  return result
}

export async function checkInstallation(input: string, options: { force?: boolean; signal?: AbortSignal } = {}): Promise<CcInstallation> {
  let candidate: ResolvedCandidate
  try { candidate = await resolveCandidate(input) } catch (error) {
    const issue = issueFromError(error, 'not-executable')
    console.warn('[CcRuntime] Installation could not be resolved', { issue })
    let path = typeof input === 'string' ? input.slice(0, 4096) : ''
    try { path = normalizeInputPath(input) } catch { /* The resolution failure is already reported above. */ }
    const result: CcInstallation = { path, compatibility: 'unavailable', recommended: false, managed: false, checkedAt: new Date().toISOString(), issue }
    putCache(path, { stamp: '', result, expires: Date.now() + 30_000 })
    return result
  }
  const key = candidate.path
  const cached = probeCache.get(key)
  if (!options.force && cached?.stamp === candidate.stamp && cached.expires > Date.now()) {
    probeCache.delete(key)
    probeCache.set(key, cached)
    return { ...cached.result }
  }
  const pendingKey = `${key}:${candidate.stamp}`
  const pending = pendingProbes.get(pendingKey)
  if (pending && !options.signal) return pending
  const signal = options.signal ? AbortSignal.any([options.signal, shutdownController.signal]) : shutdownController.signal
  const work = inspect(candidate, signal).then(result => {
    const usable = result.compatibility === 'verified' || result.compatibility === 'compatible'
    putCache(key, {
      stamp: candidate.stamp, result,
      launch: usable ? { ...candidate.launch, version: result.version! } : undefined,
      expires: usable ? Infinity : Date.now() + 30_000
    })
    return { ...result }
  }).finally(() => {
    if (pendingProbes.get(pendingKey) === work) pendingProbes.delete(pendingKey)
    runningChecks.delete(work)
  })
  runningChecks.add(work)
  if (!options.signal) pendingProbes.set(pendingKey, work)
  return work
}

export async function launchForInstallation(path: string, options: { signal?: AbortSignal } = {}): Promise<CcRuntimeLaunch | null> {
  const result = await checkInstallation(path, options)
  if (!['verified', 'compatible'].includes(result.compatibility)) return null
  const launch = probeCache.get(result.path)?.launch
  return launch ? { ...launch, argsPrefix: [...launch.argsPrefix], env: { ...launch.env } } : null
}

export function readKnownInstallation(path: string): CcInstallation | null {
  const result = probeCache.get(path)?.result
  return result ? { ...result } : null
}

export async function shutdownProbes(): Promise<void> {
  shutdownController.abort()
  await Promise.allSettled([...runningChecks])
  probeCache.clear()
}
