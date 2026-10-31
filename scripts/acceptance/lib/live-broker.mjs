import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomBytes, timingSafeEqual } from 'node:crypto'

const defaults = { maxRequests: 8, maxOutputTokens: 1024, maxInputBytes: 128 * 1024, timeoutMs: 120000 }
const ceilings = { maxRequests: 64, maxOutputTokens: 65536, maxInputBytes: 32 * 1024 * 1024, timeoutMs: 600000 }

function limitsFor(options) {
  return Object.fromEntries(Object.entries(defaults).map(([name, fallback]) => {
    const value = options[name] ?? fallback
    if (!Number.isSafeInteger(value) || value < 1 || value > ceilings[name]) throw new Error(`${name} must be an integer between 1 and ${ceilings[name]}`)
    return [name, value]
  }))
}

function endpointFor(upstream, protocol) {
  let endpoint
  try { endpoint = new URL(upstream) } catch { throw new Error('A valid upstream base URL is required') }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) throw new Error('Upstream requires HTTPS, except for a loopback test endpoint')
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Upstream base URLs cannot contain credentials, a query or a fragment')
  const base = endpoint.pathname.replace(/\/+$/, '')
  if (/\/(?:messages|chat\/completions|responses)$/.test(base)) throw new Error('Upstream must be a base URL, not a model operation URL')
  endpoint.pathname = protocol === 'anthropic' ? base + (base.endsWith('/v1') ? '/messages' : '/v1/messages') : base + '/chat/completions'
  return endpoint
}

function reject(response, status, code) {
  if (response.destroyed || response.writableEnded) return
  if (response.headersSent) { response.destroy(); return }
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' })
  response.end(JSON.stringify({ error: { type: code, message: code.replaceAll('_', ' ') } }))
}

function boundedBody(request, signal, maximum, record) {
  return new Promise((resolve, rejectBody) => {
    const chunks = []
    let settled = false
    const finish = (error, body) => {
      if (settled) return
      settled = true
      request.removeListener('data', data)
      request.removeListener('end', end)
      request.removeListener('error', failed)
      signal.removeEventListener('abort', aborted)
      if (error) { request.resume(); rejectBody(error) } else resolve(body)
    }
    const data = chunk => {
      record.inputBytes += chunk.length
      if (record.inputBytes > maximum) { finish(new Error('input_budget_exceeded')); return }
      chunks.push(chunk)
    }
    const end = () => finish(null, Buffer.concat(chunks))
    const failed = () => finish(new Error('client_cancelled'))
    const aborted = () => finish(new Error('request_cancelled'))
    request.on('data', data)
    request.once('end', end)
    request.once('error', failed)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}

function constrainPayload(payload, protocol, model, cap) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid_json_object')
  if (!Array.isArray(payload.messages)) throw new Error('messages_are_required')
  const supplied = ['max_tokens', 'max_completion_tokens'].filter(name => payload[name] !== undefined && payload[name] !== null)
  for (const name of supplied) if (!Number.isSafeInteger(payload[name]) || payload[name] < 1) throw new Error('invalid_output_limit')
  const maximum = Math.min(cap, ...supplied.map(name => payload[name]))
  const field = protocol === 'openai' && payload.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens'
  delete payload.max_tokens
  delete payload.max_completion_tokens
  delete payload.max_output_tokens
  delete payload.best_of
  payload.model = model
  payload[field] = maximum
  if (protocol === 'openai') payload.n = 1
  return Buffer.from(JSON.stringify(payload))
}

function streamRedactor(secrets) {
  const patterns = [...new Set(secrets.flatMap(value => [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]))].map(value => Buffer.from(value)).sort((a, b) => b.length - a.length)
  const tail = Math.max(...patterns.map(value => value.length)) - 1
  const replacement = Buffer.from('[REDACTED]')
  let pending = Buffer.alloc(0)
  const redact = value => {
    for (const secret of patterns) {
      let at = value.indexOf(secret)
      while (at >= 0) {
        value = Buffer.concat([value.subarray(0, at), replacement, value.subarray(at + secret.length)])
        at = value.indexOf(secret, at + replacement.length)
      }
    }
    return value
  }
  return {
    push(chunk, final = false) {
      pending = redact(Buffer.concat([pending, Buffer.from(chunk)]))
      const count = final ? pending.length : Math.max(0, pending.length - tail)
      const ready = pending.subarray(0, count)
      pending = Buffer.from(pending.subarray(count))
      return ready
    },
    clear() { pending.fill(0); for (const value of patterns) value.fill(0) },
  }
}

export async function startLiveBroker(options) {
  const { upstream, protocol, model } = options ?? {}
  let apiKey = options?.apiKey
  if (!['openai', 'anthropic'].includes(protocol)) throw new Error('Live broker protocol must be openai or anthropic')
  if (typeof apiKey !== 'string' || !apiKey || apiKey.length > 8192 || /[\r\n\0]/.test(apiKey)) throw new Error('A nonempty model API credential is required')
  if (typeof model !== 'string' || !model || model.length > 256 || /[\r\n\0]/.test(model)) throw new Error('A configured model is required')
  const limits = limitsFor(options)
  const endpoint = endpointFor(upstream, protocol)
  const clientKey = `acceptance-${randomBytes(32).toString('hex')}`
  const credential = Buffer.from(clientKey)
  const records = [], active = new Map(), tasks = new Set()
  const denied = { authentication: 0, route: 0, quota: 0, closed: 0 }
  let admitted = 0, upstreamRequests = 0, closed = false, closePromise, url
  const authorized = request => {
    const bearer = typeof request.headers.authorization === 'string' ? /^Bearer (.+)$/.exec(request.headers.authorization)?.[1] : undefined
    const provided = protocol === 'anthropic' ? request.headers['x-api-key'] ?? bearer : bearer
    if (typeof provided !== 'string') return false
    const bytes = Buffer.from(provided)
    return bytes.length === credential.length && timingSafeEqual(bytes, credential)
  }
  const handle = async (request, response) => {
    if (closed) { denied.closed++; reject(response, 503, 'broker_closed'); return }
    if (!authorized(request)) { denied.authentication++; reject(response, 401, 'broker_authentication_required'); return }
    let route
    try {
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw new Error('invalid route')
      route = new URL(request.url, url)
      if (route.origin !== url || route.search || route.hash || request.headers.host !== new URL(url).host || (request.headers.origin && request.headers.origin !== url)) throw new Error('invalid origin')
    } catch { denied.route++; reject(response, 400, 'invalid_broker_origin_or_path'); return }
    if (request.method === 'GET' && ['/models', '/v1/models'].includes(route.pathname)) {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model', type: 'model', display_name: model }], has_more: false }))
      return
    }
    const allowed = protocol === 'anthropic' ? ['/messages', '/v1/messages'] : ['/chat/completions', '/v1/chat/completions']
    if (request.method !== 'POST' || !allowed.includes(route.pathname)) { denied.route++; reject(response, 404, 'model_route_not_supported'); return }
    // Reserve before any await, including body reads: concurrent calls cannot share the last allowance.
    if (admitted >= limits.maxRequests) { denied.quota++; reject(response, 429, 'request_budget_exhausted'); return }
    const record = { sequence: ++admitted, startedAt: new Date().toISOString(), inputBytes: 0, forwardedBytes: 0, upstreamResponseBytes: 0, responseBytes: 0, upstreamStatus: null, outcome: 'reading', finishedAt: null }
    records.push(record)
    const controller = new AbortController()
    let abortReason, redactor
    const abort = reason => { if (!controller.signal.aborted) { abortReason = reason; controller.abort() } }
    active.set(controller, abort)
    const timer = setTimeout(() => abort('request_timed_out'), limits.timeoutMs)
    const clientAborted = () => abort('client_cancelled')
    const responseClosed = () => { if (!response.writableEnded) clientAborted() }
    request.once('aborted', clientAborted)
    response.once('close', responseClosed)
    try {
      if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') throw new Error('content_encoding_not_supported')
      const length = Number(request.headers['content-length'])
      if (Number.isFinite(length) && length > limits.maxInputBytes) throw new Error('input_budget_exceeded')
      const body = await boundedBody(request, controller.signal, limits.maxInputBytes, record)
      let payload
      try { payload = JSON.parse(body.toString('utf8')) } catch { throw new Error('invalid_json_object') }
      const forwarded = constrainPayload(payload, protocol, model, limits.maxOutputTokens)
      if (forwarded.length > limits.maxInputBytes) throw new Error('input_budget_exceeded')
      record.forwardedBytes = forwarded.length
      if (controller.signal.aborted) throw new Error('request_cancelled')
      const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
      if (protocol === 'anthropic') { headers['x-api-key'] = apiKey; headers['anthropic-version'] = '2023-06-01' }
      else headers.authorization = `Bearer ${apiKey}`
      record.outcome = 'upstream'
      upstreamRequests++
      const result = await fetch(endpoint, { method: 'POST', headers, body: forwarded, redirect: 'manual', signal: controller.signal })
      record.upstreamStatus = result.status
      if (!result.ok) {
        await result.body?.cancel()
        record.outcome = result.status >= 300 && result.status < 400 ? 'upstream_redirect_refused' : 'upstream_error'
        reject(response, record.outcome === 'upstream_redirect_refused' ? 502 : result.status, record.outcome)
        return
      }
      if (!result.body) throw new Error('missing_upstream_body')
      response.writeHead(result.status, { 'content-type': result.headers.get('content-type')?.includes('text/event-stream') ? 'text/event-stream' : 'application/json', 'cache-control': 'no-store' })
      redactor = streamRedactor([apiKey])
      for await (const chunk of result.body) {
        record.upstreamResponseBytes += chunk.length
        const ready = redactor.push(chunk)
        if (!ready.length) continue
        record.responseBytes += ready.length
        if (!response.write(ready)) await once(response, 'drain', { signal: controller.signal })
      }
      const tail = redactor.push(Buffer.alloc(0), true)
      record.responseBytes += tail.length
      response.end(tail)
      record.outcome = 'completed'
    } catch (error) {
      const validation = ['input_budget_exceeded', 'invalid_json_object', 'invalid_output_limit', 'messages_are_required', 'content_encoding_not_supported']
      const reason = abortReason ?? (validation.includes(error.message) ? error.message : 'upstream_failed')
      record.outcome = reason
      reject(response, reason === 'input_budget_exceeded' ? 413 : reason === 'request_timed_out' ? 504 : validation.includes(reason) ? 400 : 502, reason)
    } finally {
      clearTimeout(timer)
      request.removeListener('aborted', clientAborted)
      response.removeListener('close', responseClosed)
      active.delete(controller)
      redactor?.clear()
      record.finishedAt = new Date().toISOString()
    }
  }
  const server = createServer((request, response) => {
    const task = handle(request, response).catch(() => { reject(response, 502, 'broker_internal_error') }).finally(() => tasks.delete(task))
    tasks.add(task)
  })
  server.maxHeadersCount = 40
  server.headersTimeout = Math.min(limits.timeoutMs, 30000)
  server.requestTimeout = limits.timeoutMs
  await new Promise((resolve, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolve)
  })
  url = `http://127.0.0.1:${server.address().port}`
  const summary = () => ({
    version: 1, protocol, model, limits: { maxRequests: limits.maxRequests, maxOutputTokensPerRequest: limits.maxOutputTokens, maxInputBytesPerRequest: limits.maxInputBytes, timeoutMsPerRequest: limits.timeoutMs },
    requestsAdmitted: admitted, upstreamRequests, remainingRequests: limits.maxRequests - admitted, activeRequests: active.size,
    reservedOutputTokenCeiling: admitted * limits.maxOutputTokens, inputBytes: records.reduce((sum, record) => sum + record.inputBytes, 0), forwardedBytes: records.reduce((sum, record) => sum + record.forwardedBytes, 0),
    denied: { ...denied }, requests: records.map(record => ({ ...record })),
  })
  return {
    url, clientKey, get usage() { return summary() }, summary,
    close() {
      if (!closePromise) closePromise = (async () => {
        closed = true
        for (const abort of active.values()) abort('broker_closed')
        const stopped = new Promise(resolve => server.close(resolve))
        server.closeAllConnections()
        await Promise.allSettled([...tasks])
        await stopped
        apiKey = ''
        credential.fill(0)
      })()
      return closePromise
    },
  }
}
