import { existsSync } from 'node:fs'
import type { CcDownloadSource, CcReleaseInfo } from '../../../shared/types/cc-runtime'
import { CcRuntimeError } from './errors'
import { VERSION_PATTERN, isRecommendedVersion, compareVersion, MINIMUM_VERSION } from './policy'
import { isInstallVersion, validateSource } from './sources'
import { MAX_BINARY_BYTES, readMetadata, transferAbortError } from './transfer'

const releaseCache = new Map<string, { value: CcReleaseInfo; expires: number }>()
const pending = new Map<string, { value: Promise<CcReleaseInfo>; controller: AbortController }>()
const CACHE_CAPACITY = 32

export function getNativePlatform(): string {
  if (!['darwin', 'linux', 'win32'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) throw new CcRuntimeError('unsupported-platform')
  const musl = process.platform === 'linux' && (existsSync('/lib/libc.musl-x86_64.so.1') || existsSync('/lib/libc.musl-aarch64.so.1'))
  return `${process.platform}-${process.arch}${musl ? '-musl' : ''}`
}

async function fetchRelease(source: CcDownloadSource, requestedVersion: string, platform: string, signal: AbortSignal): Promise<CcReleaseInfo> {
  const version = VERSION_PATTERN.test(requestedVersion) ? requestedVersion : (await readMetadata(`${source.baseUrl}/${requestedVersion}`, signal)).trim()
  if (!VERSION_PATTERN.test(version) || version.length > 80) throw new CcRuntimeError('invalid-manifest')
  if (compareVersion(version, MINIMUM_VERSION) < 0) throw new CcRuntimeError('version-too-old')
  const text = await readMetadata(`${source.baseUrl}/${version}/manifest.json`, signal)
  let manifest
  try { manifest = JSON.parse(text) } catch (cause) { throw new CcRuntimeError('invalid-manifest', { cause }) }
  if (manifest?.version !== version || !manifest.platforms || typeof manifest.platforms !== 'object') throw new CcRuntimeError('invalid-manifest')
  const artifact = manifest.platforms[platform]
  if (!artifact) throw new CcRuntimeError('unsupported-platform')
  if (typeof artifact.checksum !== 'string' || !/^[a-fA-F0-9]{64}$/.test(artifact.checksum)
    || (artifact.size !== undefined && (!Number.isSafeInteger(artifact.size) || artifact.size <= 0 || artifact.size > MAX_BINARY_BYTES))) throw new CcRuntimeError('invalid-manifest')
  return { requestedVersion, version, sourceId: source.id, platform, checksum: artifact.checksum.toLowerCase(),
    ...(artifact.size !== undefined ? { size: artifact.size } : {}), recommended: isRecommendedVersion(version) }
}

async function withSignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  if (signal.aborted) throw transferAbortError(signal)
  let abort: (() => void) | undefined
  try {
    return await Promise.race([work, new Promise<T>((_resolve, reject) => {
      abort = () => reject(transferAbortError(signal))
      signal.addEventListener('abort', abort, { once: true })
    })])
  } finally { if (abort) signal.removeEventListener('abort', abort) }
}

export async function lookupRelease(sourceInput: CcDownloadSource, requestedVersion: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<CcReleaseInfo> {
  const source = validateSource(sourceInput)
  if (!isInstallVersion(requestedVersion)) throw new CcRuntimeError('invalid-version')
  const platform = getNativePlatform()
  const key = `${source.baseUrl}\0${requestedVersion}\0${platform}`
  const cached = releaseCache.get(key)
  if (cached && cached.expires > Date.now()) {
    releaseCache.delete(key); releaseCache.set(key, cached)
    return { ...cached.value, sourceId: source.id }
  }
  const existing = pending.get(key)
  if (existing) return { ...await withSignal(existing.value, options.signal), sourceId: source.id }
  if (pending.size >= 4) throw new CcRuntimeError('probe-busy')
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  const timeout = setTimeout(() => controller.abort(new CcRuntimeError('source-timeout')), options.timeoutMs ?? 12_000)
  const value = withSignal(fetchRelease(source, requestedVersion, platform, controller.signal), controller.signal).then(result => {
    releaseCache.delete(key)
    releaseCache.set(key, { value: result, expires: Date.now() + (VERSION_PATTERN.test(requestedVersion) ? 60_000 : 15_000) })
    while (releaseCache.size > CACHE_CAPACITY) releaseCache.delete(releaseCache.keys().next().value!)
    return result
  }).finally(() => {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
    if (pending.get(key)?.value === value) pending.delete(key)
  })
  pending.set(key, { value, controller })
  return value
}

export function clearReleaseCache(): void {
  for (const operation of pending.values()) operation.controller.abort()
  pending.clear()
  releaseCache.clear()
}
