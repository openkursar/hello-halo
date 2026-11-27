import { net } from 'electron'
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
  if (!isUrlAllowedByPolicy(url.href)) return fail('BROWSER_POLICY_BLOCKED', 'Request blocked by browser policy.')
  // Existing privileged helpers send flat fields; fetchJson wraps them in options.
  const options = payload.options && typeof payload.options === 'object' && !Array.isArray(payload.options)
    ? payload.options : payload
  const method = String(options.method || 'GET').toUpperCase()
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return fail('HOST_UNSUPPORTED_METHOD', 'HTTP method is not supported.')
  if (grant.write && !grant.confirmed) return fail('CONFIRMATION_REQUIRED', 'Write commands require explicit confirmation.')
  if (!grant.write && !['GET', 'HEAD', 'POST'].includes(method)) return fail('HOST_UNSUPPORTED_METHOD', 'Read commands cannot use a mutating HTTP method.')
  // The request goes out as the program wrote it, the way a page's own request would; only
  // headers the network stack owns are left to it.
  const headers = new Headers(options.headers || {})
  let cookieHint = ''
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase() === 'cookie') {
      cookieHint = headers.get(name)!.trim()
      headers.delete(name)
    } else if (/^(cookie2|host|connection|content-length|transfer-encoding|keep-alive|upgrade|expect)$/i.test(name)) {
      headers.delete(name)
    }
  }
  if (options.body !== undefined && typeof options.body !== 'string') return fail('INVALID_ARGS', 'Request body must be text.')
  const fixedHeaders: Record<string, string> = Object.fromEntries(headers)
  let body: Buffer | undefined = options.body === undefined ? undefined
    : options.bodyEncoding === 'base64' ? Buffer.from(options.body || '', 'base64') : Buffer.from(options.body, 'utf8')
  // Redirects are followed one hop at a time, as a browser would, so the program learns where it ended.
  let target = url
  let hopMethod = method
  let redirected = false
  for (let hop = 0; ; hop++) {
    const answer = await sendOnce(target, hopMethod, fixedHeaders, cookieHint, body, signal)
    if (!answer.location) {
      return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, url: target.href, redirected,
        headers: answer.headers, body: answer.body.toString(options.responseEncoding === 'base64' ? 'base64' : 'utf8'),
        ...(options.responseEncoding === 'base64' ? { bodyEncoding: 'base64', size: answer.body.length } : {}) }
    }
    if (hop >= MAX_REDIRECTS) return fail('HOST_TOO_MANY_REDIRECTS', 'The site redirected this request too many times.')
    const next = new URL(answer.location, target)
    if (!['http:', 'https:'].includes(next.protocol)) return fail('INVALID_URL', 'The site redirected to a non-HTTP address.')
    if (!isUrlAllowedByPolicy(next.href)) return fail('BROWSER_POLICY_BLOCKED', 'Redirect blocked by browser policy.')
    if (answer.status === 303 || ((answer.status === 301 || answer.status === 302) && hopMethod === 'POST')) {
      hopMethod = 'GET'
      body = undefined
    }
    // A cookie the program supplied belongs to the site it named.
    if (next.origin !== target.origin) cookieHint = ''
    target = next
    redirected = true
  }
}

const MAX_REDIRECTS = 10
const DROPPED_RESPONSE_HEADERS = /^(set-cookie2?|www-authenticate|proxy-authenticate)$/i

interface Answer { status: number; location?: string; headers: Record<string, string>; body: Buffer }

/** One request through the browser session, without following a redirect. */
async function sendOnce(url: URL, method: string, headers: Record<string, string>, cookieHint: string,
  body: Buffer | undefined, signal: AbortSignal): Promise<Answer> {
  signal.throwIfAborted()
  const browser = getBrowserSession()
  // Cookies the program names that the browser does not hold are sent beside the browser's own.
  let cookieHeader: string | undefined
  if (cookieHint) {
    const jar = new Map((await browser.cookies.get({ url: url.href })).map(cookie => [cookie.name, cookie.value]))
    let extra = false
    for (const pair of cookieHint.split(/;\s*/)) {
      const at = pair.indexOf('=')
      if (at <= 0) continue
      if (jar.get(pair.slice(0, at)) !== pair.slice(at + 1)) extra = true
      jar.set(pair.slice(0, at), pair.slice(at + 1))
    }
    if (extra) cookieHeader = [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
  }
  return new Promise<Answer>((resolve, reject) => {
    const request = net.request({ method, url: url.href, session: browser, useSessionCookies: !cookieHeader, redirect: 'manual' })
    for (const [name, value] of Object.entries(headers)) request.setHeader(name, value)
    if (cookieHeader) request.setHeader('Cookie', cookieHeader)
    let settled = false
    const done = (error: unknown, answer?: Answer) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(answer!)
    }
    const abort = () => { request.abort(); done(signal.reason ?? new Error('Request cancelled.')) }
    signal.addEventListener('abort', abort, { once: true })
    request.on('redirect', (status, _method, location, responseHeaders) => {
      request.abort()
      done(undefined, { status, location, headers: flatten(responseHeaders), body: Buffer.alloc(0) })
    })
    request.on('response', response => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BYTES / 2) {
          request.abort()
          done(Object.assign(new Error('Adapter response exceeds the size limit.'), { code: 'HOST_PAYLOAD_TOO_LARGE' }))
        } else chunks.push(chunk)
      })
      response.on('end', () => done(undefined, { status: response.statusCode, headers: flatten(response.headers), body: Buffer.concat(chunks) }))
      response.on('error', (error: Error) => done(error))
    })
    request.on('error', error => done(error))
    if (body) request.write(body)
    request.end()
  })
}

function flatten(headers: Record<string, string | string[]>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers)
    .filter(([name]) => !DROPPED_RESPONSE_HEADERS.test(name))
    .map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : String(value)]))
}
