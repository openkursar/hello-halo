import { getBrowserSession } from '../browser-view.service'
import { z } from 'zod'
import { isUrlAllowedByPolicy } from '../browser-policy.service'
import { fail, MAX_BYTES } from './protocol'

export const grantSchema = z.object({
  name: z.string().min(1).max(128), commandId: z.string().min(1).max(128),
  invokedCommand: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/).optional(),
  hosts: z.array(z.string().regex(/^(\*\.)?[a-z0-9.-]+$/)).min(1).max(100),
  pageHosts: z.array(z.string().regex(/^(\*\.)?[a-z0-9.-]+$/)).min(1).max(100).optional(),
  initialUrl: z.string().url().optional(),
  write: z.boolean(), confirmed: z.boolean(),
}).strict()
export type HostGrant = z.infer<typeof grantSchema>

export async function fetchForAdapter(grant: HostGrant, payload: Record<string, any>, signal: AbortSignal): Promise<unknown> {
  let url: URL
  try { url = new URL(payload.url) } catch { return fail('INVALID_URL', 'Adapter fetch requires an absolute HTTP(S) URL.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return fail('INVALID_URL', 'Adapter fetch URL is not allowed.')
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!isUrlAllowedByPolicy(url.href)) return fail('BROWSER_POLICY_BLOCKED', 'Request blocked by browser policy.')
  if (!grant.hosts.some(pattern => pattern.startsWith('*.')
    ? hostname === pattern.slice(2) || hostname.endsWith(`.${pattern.slice(2)}`) : hostname === pattern)) {
    return fail('HOST_SCOPE_DENIED', 'Adapter request is outside its declared host scope.')
  }
  // Existing privileged helpers send flat fields; fetchJson wraps them in options.
  const options = payload.options && typeof payload.options === 'object' && !Array.isArray(payload.options)
    ? payload.options : payload
  const method = String(options.method || 'GET').toUpperCase()
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return fail('HOST_UNSUPPORTED_METHOD', 'HTTP method is not supported.')
  if (grant.write && !grant.confirmed) return fail('CONFIRMATION_REQUIRED', 'Write commands require explicit confirmation.')
  if (!grant.write && !['GET', 'HEAD', 'POST'].includes(method)) return fail('HOST_UNSUPPORTED_METHOD', 'Read commands cannot use a mutating HTTP method.')
  const headers = new Headers(options.headers || {})
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase() === 'cookie') {
      // Some helpers include an empty cookie hint before login. Let Chromium
      // supply the current session; only nonempty hints need ownership checks.
      const hint = headers.get(name)!.trim()
      if (!hint) { headers.delete(name); continue }
      const cookies = await getBrowserSession().cookies.get({ url: url.href })
      const valid = new Set(cookies.map(cookie => `${cookie.name}=${cookie.value}`))
      if (!hint.split(/;\s*/).every(value => valid.has(value))) return fail('HOST_HEADER_DENIED', 'Cookie headers must match the Halo browser session.')
      headers.delete(name)
      continue
    }
    if (name.toLowerCase() === 'origin' || name.toLowerCase() === 'referer') {
      let source: URL
      try { source = new URL(headers.get(name)!) } catch { return fail('HOST_HEADER_DENIED', 'Invalid request origin.') }
      if (source.origin !== url.origin) return fail('HOST_HEADER_DENIED', 'Request origin must match the destination.')
      continue
    }
    if (/^(cookie2|host|proxy-authorization|connection|content-length|transfer-encoding)$/i.test(name) || /^sec-/i.test(name)) {
      return fail('HOST_HEADER_DENIED', 'This header must be managed by the browser host.')
    }
  }
  if (options.body !== undefined && typeof options.body !== 'string') return fail('INVALID_ARGS', 'Request body must be text.')
  const response = await getBrowserSession().fetch(url.href, {
    method, headers, body: options.bodyEncoding === 'base64' ? Buffer.from(options.body || '', 'base64') : options.body,
    credentials: 'include', redirect: 'manual', signal,
  })
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (reader) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > MAX_BYTES / 2) return fail('HOST_PAYLOAD_TOO_LARGE', 'Adapter response exceeds the size limit.')
      chunks.push(chunk.value)
    }
  } finally { await reader?.cancel() }
  const responseHeaders = Object.fromEntries([...response.headers].filter(([name]) => !/^(set-cookie2?|www-authenticate|proxy-authenticate)$/i.test(name)))
  // Electron's session.fetch constructs a Response without URL metadata. Manual
  // redirects guarantee the request URL is authoritative when that field is empty.
  return { ok: response.ok, status: response.status, url: response.url || url.href, redirected: response.redirected,
    headers: responseHeaders, body: Buffer.concat(chunks).toString(options.responseEncoding === 'base64' ? 'base64' : 'utf8'),
    ...(options.responseEncoding === 'base64' ? { bodyEncoding: 'base64', size } : {}) }
}
