import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { CcDownloadSource, CcInstallation, CcInstallProgress } from '../../../shared/types/cc-runtime'
import { rememberInstallation } from './catalog'
import { CcRuntimeError, issueFromError } from './errors'
import { getRuntimeRoot } from './paths'
import { checkInstallation } from './probe'
import { VERSION_PATTERN } from './policy'
import { getNativePlatform, lookupRelease } from './releases'
import { reuseManagedInstallation } from './reuse'
import { isInstallVersion, validateSource } from './sources'
import { MAX_BINARY_BYTES, responseBody, transferAbortError } from './transfer'

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000

async function downloadBinary(
  url: string, destination: string, checksum: string, expectedSize: number | undefined,
  signal: AbortSignal, progress: (value: CcInstallProgress) => void, version: string
): Promise<void> {
  const response = await responseBody(url, signal)
  const length = Number(response.headers.get('content-length'))
  const totalBytes = expectedSize || (Number.isFinite(length) && length > 0 ? length : undefined)
  if (totalBytes && totalBytes > MAX_BINARY_BYTES) {
    await response.body!.cancel()
    throw new CcRuntimeError('invalid-manifest')
  }
  const reader = response.body!.getReader()
  let file: Awaited<ReturnType<typeof open>> | undefined
  const hash = createHash('sha256')
  let downloadedBytes = 0
  let lastReport = 0
  let failure: unknown
  try {
    file = await open(destination, 'wx', 0o600)
    while (true) {
      signal.throwIfAborted()
      let next: ReadableStreamReadResult<Uint8Array>
      try { next = await reader.read() } catch (cause) {
        throw new CcRuntimeError(signal.aborted ? 'cancelled' : 'download-failed', { cause })
      }
      if (next.done) break
      downloadedBytes += next.value.length
      if (downloadedBytes > MAX_BINARY_BYTES || (expectedSize && downloadedBytes > expectedSize)) throw new CcRuntimeError('checksum-mismatch')
      hash.update(next.value)
      await file.writeFile(next.value)
      if (Date.now() - lastReport >= 250) {
        progress({ phase: 'downloading', version, downloadedBytes, totalBytes })
        lastReport = Date.now()
      }
    }
    progress({ phase: 'verifying', version, downloadedBytes, totalBytes })
    if ((expectedSize && downloadedBytes !== expectedSize) || hash.digest('hex') !== checksum.toLowerCase()) throw new CcRuntimeError('checksum-mismatch')
    await file.sync()
  } catch (error) {
    failure = error instanceof CcRuntimeError ? error.cause ?? error : error
    throw error
  } finally {
    await file?.close()
    await reader.cancel().catch(error => {
      if (error !== failure) console.warn('[CcRuntime] Binary stream cleanup failed', { name: (error as Error).name })
    })
  }
}


export async function downloadAndPublish(
  sourceInput: CcDownloadSource,
  requestedVersion: string,
  signal: AbortSignal,
  progress: (value: CcInstallProgress) => void
): Promise<CcInstallation> {
  const source = validateSource(sourceInput)
  if (!isInstallVersion(requestedVersion)) throw new CcRuntimeError('invalid-version')
  const platform = getNativePlatform()
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const timeout = setTimeout(() => controller.abort(new CcRuntimeError('source-timeout')), DOWNLOAD_TIMEOUT_MS)
  let staging: string | undefined
  try {
    progress({ phase: 'checking', downloadedBytes: 0, version: requestedVersion })
    const exactVersion = VERSION_PATTERN.test(requestedVersion)
    if (exactVersion) {
      const reused = await reuseManagedInstallation(requestedVersion, platform, controller.signal, { sourceUrl: source.baseUrl, requireSourceMatch: true })
      if (reused) return reused
    }
    progress({ phase: 'manifest', downloadedBytes: 0 })
    const release = await lookupRelease(source, requestedVersion, { signal: controller.signal })
    const { version, checksum, size } = release
    const reused = await reuseManagedInstallation(version, platform, controller.signal, { checksum, sourceUrl: source.baseUrl })
    if (reused) return reused
    const root = getRuntimeRoot()
    await mkdir(root, { recursive: true })
    staging = join(root, `.install-${randomUUID()}`)
    await mkdir(staging, { mode: 0o700 })
    const binary = process.platform === 'win32' ? 'claude.exe' : 'claude'
    const path = join(staging, binary)
    await downloadBinary(`${source.baseUrl}/${version}/${platform}/${binary}`, path, checksum, size, controller.signal, progress, version)
    await chmod(path, 0o755)
    progress({ phase: 'checking', version, downloadedBytes: size || 0, totalBytes: size })
    const result = await checkInstallation(path, { force: true, signal: controller.signal })
    if (result.kind !== 'native' || !['verified', 'compatible'].includes(result.compatibility)) throw new CcRuntimeError(result.issue || 'protocol-unsupported')
    if (result.version !== version) throw new CcRuntimeError('version-mismatch')
    if (controller.signal.aborted) throw transferAbortError(controller.signal)
    let published = join(root, `${version}-${platform}-${checksum.slice(0, 16)}`)
    try { await rename(staging, published) } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code || '')) throw error
      // An old file may still be mapped by a session, even when it is damaged.
      published = `${published}-${randomUUID()}`
      await rename(staging, published)
      console.warn('[CcRuntime] Published a fresh copy without replacing an existing runtime', { version, platform })
    }
    staging = undefined
    const installed: CcInstallation = { ...result, path: join(published, binary), resolvedPath: join(published, binary), managed: true,
      sourceId: source.id, installedAt: new Date().toISOString() }
    await rememberInstallation(installed, { platform, checksum, sourceUrl: source.baseUrl })
    return installed
  } catch (error) {
    if (controller.signal.aborted) throw transferAbortError(controller.signal)
    throw new CcRuntimeError(issueFromError(error, 'storage-failed'), { cause: error })
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
    if (staging) await rm(staging, { recursive: true, force: true }).catch(error => console.warn('[CcRuntime] Staging cleanup failed', { code: (error as NodeJS.ErrnoException).code }))
  }
}
