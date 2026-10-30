import { proxyFetch } from '../proxy-fetch'
import { CcRuntimeError } from './errors'

export const MAX_BINARY_BYTES = 1024 * 1024 * 1024
const MAX_METADATA_BYTES = 128 * 1024

export function transferAbortError(signal: AbortSignal): CcRuntimeError {
  return signal.reason instanceof CcRuntimeError ? signal.reason : new CcRuntimeError('cancelled')
}

function networkError(cause: unknown): CcRuntimeError {
  const error = cause as { code?: string; cause?: { code?: string } }
  const code = error?.code || error?.cause?.code || ''
  return new CcRuntimeError(/TIMEOUT|TIMEDOUT/.test(code) ? 'source-timeout' : 'source-unreachable', { cause })
}

export async function responseBody(url: string, signal: AbortSignal, metadata = false): Promise<Response> {
  const secure = new URL(url).protocol === 'https:'
  let current = url
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (signal.aborted) throw transferAbortError(signal)
    let response: Response
    try { response = await proxyFetch(current, { signal, redirect: 'manual' }) } catch (cause) {
      if (signal.aborted) throw transferAbortError(signal)
      throw networkError(cause)
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location) throw new CcRuntimeError('source-unreachable')
      let next: URL
      try { next = new URL(location, current) } catch { throw new CcRuntimeError('invalid-source') }
      if (!['https:', 'http:'].includes(next.protocol) || next.username || next.password || (secure && next.protocol !== 'https:')) throw new CcRuntimeError('invalid-source')
      current = next.toString()
      continue
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      if ([401, 403, 407].includes(response.status)) throw new CcRuntimeError('source-unauthorized')
      if ([408, 504].includes(response.status)) throw new CcRuntimeError('source-timeout')
      if (response.status === 404 && metadata) throw new CcRuntimeError('version-not-found')
      if (response.status >= 500 || response.status === 429) throw new CcRuntimeError('source-unreachable')
      throw new CcRuntimeError(metadata ? 'invalid-manifest' : 'download-failed')
    }
    return response
  }
  throw new CcRuntimeError('source-unreachable')
}

export async function readMetadata(url: string, signal: AbortSignal): Promise<string> {
  const response = await responseBody(url, signal, true)
  const reader = response.body!.getReader()
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  const chunks: Buffer[] = []
  let bytes = 0
  let failure: unknown
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.length
      if (bytes > MAX_METADATA_BYTES) throw new CcRuntimeError('invalid-manifest')
      chunks.push(Buffer.from(next.value))
    }
    return Buffer.concat(chunks).toString('utf8')
  } catch (error) {
    failure = error
    if (signal.aborted) throw transferAbortError(signal)
    if (error instanceof CcRuntimeError) throw error
    throw networkError(error)
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(error => {
      if (error !== failure) console.warn('[CcRuntime] Metadata stream cleanup failed', { name: (error as Error).name })
    })
  }
}
