import type { CcDownloadSource } from '../../../shared/types/cc-runtime'
import { getRuntime } from '../external-runtime'
export { getNativePlatform } from '../external-runtime/compatibility'
export async function lookupRelease(source: CcDownloadSource, version: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  const { url: _url, integrity: _integrity, payloadVersion: _payloadVersion, ...release } = await getRuntime('anthropic').releases.lookupRelease(source, version, options)
  return release
}
export const clearReleaseCache = () => getRuntime('anthropic').releases.clearReleaseCache()
