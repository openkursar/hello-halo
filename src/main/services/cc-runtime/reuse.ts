import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { CcInstallation } from '../../../shared/types/cc-runtime'
import { getManagedCatalogEntries, rememberInstallation } from './catalog'
import { CcRuntimeError, issueFromError } from './errors'
import { checkInstallation } from './probe'
import { MAX_BINARY_BYTES, transferAbortError } from './transfer'

export async function reuseManagedInstallation(version: string, platform: string, signal: AbortSignal, options: { checksum?: string; path?: string; sourceUrl?: string; requireSourceMatch?: boolean } = {}): Promise<CcInstallation | null> {
  const entries = await getManagedCatalogEntries(version, platform)
  for (const entry of entries) {
    if (signal.aborted) throw transferAbortError(signal)
    const { installation, integrity } = entry
    if (options.path && installation.path !== options.path) continue
    if (!integrity?.checksum && !integrity?.checksumPrefix) continue
    if (options.requireSourceMatch && integrity.sourceUrl !== options.sourceUrl) continue
    if (options.checksum && integrity.checksum && options.checksum !== integrity.checksum) continue
    if (options.checksum && integrity.checksumPrefix && !options.checksum.startsWith(integrity.checksumPrefix)) continue
    try {
      const info = await stat(installation.path)
      if (!info.isFile() || info.size > MAX_BINARY_BYTES) throw new CcRuntimeError('not-executable')
      const hash = createHash('sha256')
      const stream = createReadStream(installation.path)
      const abort = () => stream.destroy(transferAbortError(signal))
      signal.addEventListener('abort', abort, { once: true })
      try {
        for await (const chunk of stream) hash.update(chunk)
      } finally { signal.removeEventListener('abort', abort); stream.destroy() }
      const checksum = hash.digest('hex')
      if ((integrity.checksum && checksum !== integrity.checksum) || (integrity.checksumPrefix && !checksum.startsWith(integrity.checksumPrefix))) throw new CcRuntimeError('checksum-mismatch')
      if (options.checksum && checksum !== options.checksum) {
        console.log('[CcRuntime] Installed version differs from the selected source release', { version, platform })
        continue
      }
      const checked = await checkInstallation(installation.path, { force: true, signal })
      if (!['verified', 'compatible'].includes(checked.compatibility)) throw new CcRuntimeError(checked.issue || 'protocol-unsupported')
      if (checked.kind !== 'native' || checked.version !== version) throw new CcRuntimeError('version-mismatch')
      if (signal.aborted) throw transferAbortError(signal)
      const result = { ...installation, ...checked, managed: true }
      await rememberInstallation(result, { platform, checksum, ...(options.sourceUrl || integrity.sourceUrl ? { sourceUrl: options.sourceUrl || integrity.sourceUrl } : {}) })
      console.log('[CcRuntime] Reusing a checked installed version without downloading', { version, platform })
      return result
    } catch (error) {
      if (signal.aborted) throw transferAbortError(signal)
      const issue = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : issueFromError(error, 'not-executable')
      console.warn('[CcRuntime] Installed version cannot be reused', { version, platform, issue })
      await rememberInstallation({ ...installation, compatibility: 'unavailable', issue, checkedAt: new Date().toISOString() }, integrity)
    }
  }
  return null
}
