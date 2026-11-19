import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { RuntimeInstallation } from '../../../shared/types/external-runtime'
import type { RuntimeCatalog } from './catalog'
import { hasRequiredIntegrity, validComponentPath } from './catalog'
import { RuntimeError, issueFromError } from './errors'
import type { RuntimeProvider } from './provider'
import { MAX_BINARY_BYTES, transferAbortError } from './transfer'

export interface ReuseOptions {
  checksum?: string
  path?: string
  sourceUrl?: string
  requireSourceMatch?: boolean
  artifactIntegrity?: string
}
interface ReuseProbe {
  checkInstallation(path: string, options: { force?: boolean; signal?: AbortSignal }): Promise<RuntimeInstallation>
}

async function hashFile(path: string, signal: AbortSignal, expectedSize?: number): Promise<string> {
  if (signal.aborted) throw transferAbortError(signal)
  const info = await lstat(path)
  if (!info.isFile() || info.size > MAX_BINARY_BYTES || (expectedSize !== undefined && info.size !== expectedSize)) throw new RuntimeError('not-executable')
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  const abort = () => stream.destroy(transferAbortError(signal))
  signal.addEventListener('abort', abort, { once: true })
  let bytes = 0
  try {
    if (signal.aborted) throw transferAbortError(signal)
    for await (const chunk of stream) {
      bytes += chunk.length
      if (bytes > MAX_BINARY_BYTES || bytes > info.size) throw new RuntimeError('checksum-mismatch')
      hash.update(chunk)
    }
    if (bytes !== info.size) throw new RuntimeError('checksum-mismatch')
    return hash.digest('hex')
  } finally { signal.removeEventListener('abort', abort); stream.destroy() }
}

function contained(root: string, path: string): boolean {
  const child = relative(root, path)
  return child !== '' && child !== '..' && !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(child)
}

export function createRuntimeReuse(provider: RuntimeProvider, catalog: RuntimeCatalog, probe: ReuseProbe) {
  async function reuseManagedInstallation(version: string, platform: string, signal: AbortSignal, options: ReuseOptions = {}): Promise<RuntimeInstallation | null> {
    const entries = await catalog.getManagedCatalogEntries(version, platform)
    for (const entry of entries) {
      if (signal.aborted) throw transferAbortError(signal)
      const { installation, integrity } = entry
      if (options.path && installation.path !== options.path) continue
      if (!integrity) continue
      const componentIntegrity = Boolean(integrity.artifactIntegrity && integrity.directory && integrity.components?.length)
      if (!componentIntegrity && !integrity.checksum && !integrity.checksumPrefix) continue
      if (options.requireSourceMatch && (!options.sourceUrl || integrity.sourceUrl !== options.sourceUrl)) continue
      if (options.artifactIntegrity && integrity.artifactIntegrity !== options.artifactIntegrity) continue
      if (options.checksum && integrity.checksum && options.checksum !== integrity.checksum) continue
      if (options.checksum && integrity.checksumPrefix && !options.checksum.startsWith(integrity.checksumPrefix)) continue
      try {
        if (!hasRequiredIntegrity(provider, entry)) throw new RuntimeError('checksum-mismatch')
        let checksum: string | undefined
        if (componentIntegrity) {
          const directory = resolve(integrity.directory!)
          const actualDirectory = await realpath(directory)
          const executable = await realpath(installation.path)
          if (!contained(actualDirectory, executable)) throw new RuntimeError('checksum-mismatch')
          const required = provider.requiredComponents?.(platform)
          if (required?.length && executable !== await realpath(join(directory, required[0]))) throw new RuntimeError('checksum-mismatch')
          let total = 0
          let executableChecked = false
          for (const component of integrity.components!) {
            if (!validComponentPath(component.path)) throw new RuntimeError('checksum-mismatch')
            total += component.size
            if (total > MAX_BINARY_BYTES) throw new RuntimeError('checksum-mismatch')
            const path = join(directory, component.path)
            const actualPath = await realpath(path)
            if (!contained(actualDirectory, actualPath)) throw new RuntimeError('checksum-mismatch')
            const digest = await hashFile(path, signal, component.size)
            if (digest !== component.checksum) throw new RuntimeError('checksum-mismatch')
            if (actualPath === executable) { executableChecked = true; checksum = digest }
          }
          if (!executableChecked) throw new RuntimeError('checksum-mismatch')
        } else {
          checksum = await hashFile(installation.path, signal)
          if ((integrity.checksum && checksum !== integrity.checksum) || (integrity.checksumPrefix && !checksum.startsWith(integrity.checksumPrefix))) throw new RuntimeError('checksum-mismatch')
        }
        if (options.checksum && checksum !== options.checksum) {
          console.log('[ExternalRuntime] Installed version differs from the selected source release', { runtime: provider.id, version, platform })
          continue
        }
        const checked = await probe.checkInstallation(installation.path, { force: true, signal })
        if (!['verified', 'compatible'].includes(checked.compatibility)) throw new RuntimeError(checked.issue || 'protocol-unsupported')
        if (checked.kind !== 'native' || checked.version !== version) throw new RuntimeError('version-mismatch')
        if (signal.aborted) throw transferAbortError(signal)
        const result = { ...installation, ...checked, managed: true }
        await catalog.rememberInstallation(result, {
          ...integrity, platform, ...(checksum ? { checksum } : {}),
          ...(options.sourceUrl || integrity.sourceUrl ? { sourceUrl: options.sourceUrl || integrity.sourceUrl } : {})
        })
        console.log('[ExternalRuntime] Reusing a checked installed version without downloading', { runtime: provider.id, version, platform })
        return result
      } catch (error) {
        if (signal.aborted) throw transferAbortError(signal)
        const issue = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : issueFromError(error, 'not-executable')
        console.warn('[ExternalRuntime] Installed version cannot be reused', { runtime: provider.id, version, platform, issue })
        await catalog.rememberInstallation({ ...installation, compatibility: 'unavailable', issue, checkedAt: new Date().toISOString() }, integrity)
      }
    }
    return null
  }
  return { reuseManagedInstallation }
}
