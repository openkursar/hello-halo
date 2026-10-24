import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'

export const liveProviders = {
  deepseek: { protocol: 'anthropic', provider: 'anthropic', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/anthropic' },
  glm: { protocol: 'openai-compat', provider: 'zhipu-coding', model: 'glm-5.3-flash', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' },
}

export async function startProviderBroker(key, provider = liveProviders.deepseek) {
  if (!key) throw new Error('A model credential is required')
  const token = `fixture-${randomUUID()}`
  const requests = []
  const active = new Set()
  const secret = Buffer.from(key)
  const replacement = Buffer.from('[REDACTED]')
  const redact = buffer => {
    let at
    while ((at = buffer.indexOf(secret)) >= 0) buffer = Buffer.concat([buffer.subarray(0, at), replacement, buffer.subarray(at + secret.length)])
    return buffer
  }
  const server = createServer(async (request, response) => {
    const authorization = request.headers['x-api-key'] ?? request.headers.authorization?.replace(/^Bearer /, '')
    if (authorization !== token) { response.writeHead(401).end(); return }
    const path = new URL(request.url, 'http://localhost').pathname
    if (request.method === 'GET' && /\/models$/.test(path)) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ data: [{ id: provider.model, type: 'model', display_name: provider.model }], has_more: false }))
      return
    }
    const acceptedPath = provider.protocol === 'anthropic' ? /^\/(v1\/)?messages$/ : /^\/(v1\/)?chat\/completions$/
    if (request.method !== 'POST' || !acceptedPath.test(path)) { response.writeHead(404).end(); return }
    const controller = new AbortController()
    active.add(controller)
    const timer = setTimeout(() => controller.abort(), 120000)
    const record = { startedAt: new Date().toISOString(), bytes: 0, status: null, completed: false, aborted: false }
    requests.push(record)
    request.once('aborted', () => controller.abort())
    response.once('close', () => { if (!response.writableEnded) controller.abort() })
    try {
      const chunks = []
      for await (const chunk of request) {
        record.bytes += chunk.length
        if (record.bytes > 24 * 1024 * 1024) throw new Error('Broker request exceeds its byte budget')
        chunks.push(chunk)
      }
      const body = Buffer.concat(chunks)
      const payload = JSON.parse(body)
      if (payload.model !== provider.model) throw new Error('Unexpected model requested by the application')
      record.model = payload.model
      record.messages = payload.messages?.length
      const headers = new Headers()
      for (const [name, value] of Object.entries(request.headers)) {
        if (value && !['host', 'connection', 'content-length', 'transfer-encoding', 'authorization', 'x-api-key'].includes(name)) {
          headers.set(name, Array.isArray(value) ? value.join(', ') : value)
        }
      }
      if (provider.protocol === 'anthropic') headers.set('x-api-key', key)
      else headers.set('authorization', 'Bearer ' + key)
      const endpoint = provider.baseUrl + (provider.protocol === 'anthropic' ? '/v1/messages' : '/chat/completions')
      const upstream = await fetch(endpoint, {
        method: 'POST', headers, body, signal: controller.signal,
      })
      record.status = upstream.status
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
      let pending = Buffer.alloc(0)
      for await (const chunk of upstream.body) {
        pending = redact(Buffer.concat([pending, Buffer.from(chunk)]))
        const count = Math.max(0, pending.length - secret.length + 1)
        if (count && !response.write(pending.subarray(0, count))) await once(response, 'drain', { signal: controller.signal })
        pending = Buffer.from(pending.subarray(count))
      }
      response.end(redact(pending))
      record.completed = true
    } catch (error) {
      record.aborted = controller.signal.aborted
      record.error = String(error.message).replaceAll(key, '[REDACTED]')
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' })
      if (!response.destroyed) response.end(JSON.stringify({ error: { message: record.error } }))
    } finally {
      clearTimeout(timer)
      active.delete(controller)
      record.finishedAt = new Date().toISOString()
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`, token, requests,
    async close() {
      for (const controller of active) controller.abort()
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}
