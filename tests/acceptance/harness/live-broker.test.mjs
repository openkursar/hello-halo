import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { randomUUID } from 'node:crypto'
import { startLiveBroker } from '../../../scripts/acceptance/lib/live-broker.mjs'

const payload = { model: 'untrusted-selection', messages: [{ role: 'user', content: 'Synthetic acceptance prompt' }], stream: false }

async function setup(context, options = {}, handler = (_request, response) => response.end('{"ok":true}')) {
  const received = []
  const upstream = createServer(async (incoming, response) => {
    const chunks = []
    for await (const chunk of incoming) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString()
    const record = { path: incoming.url, headers: incoming.headers, body: body ? JSON.parse(body) : null }
    received.push(record)
    await handler(incoming, response, record)
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const key = `fake-provider-key-${randomUUID()}`
  const broker = await startLiveBroker({ upstream: `http://127.0.0.1:${upstream.address().port}${options.base ?? '/v1'}`, apiKey: key, protocol: 'openai', model: 'test-model', ...options })
  context.after(async () => { await broker.close(); const stopped = new Promise(resolve => upstream.close(resolve)); upstream.closeAllConnections(); await stopped })
  return { broker, received, key, upstream }
}

function send(broker, { target = '/v1/chat/completions', method = 'POST', body = payload, headers = {}, authenticate = true } = {}) {
  return new Promise((resolve, reject) => {
    const client = request(broker.url, { path: target, method, headers: { ...(authenticate ? { authorization: `Bearer ${broker.clientKey}` } : {}), 'content-type': 'application/json', ...headers } }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString() }))
    })
    client.on('error', reject)
    client.end(method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body))
  })
}

test('only authenticated same-origin model routes can reach the configured endpoint', async context => {
  const { broker, received } = await setup(context)
  assert.equal(new URL(broker.url).hostname, '127.0.0.1')
  assert.equal((await send(broker, { authenticate: false })).status, 401)
  assert.equal((await send(broker, { target: 'http://example.invalid/v1/chat/completions' })).status, 400)
  assert.equal((await send(broker, { headers: { origin: 'https://example.invalid' } })).status, 400)
  assert.equal((await send(broker, { target: '/v1/chat/completions?upstream=elsewhere' })).status, 400)
  assert.equal((await send(broker, { target: '/v1/responses' })).status, 404)
  assert.equal((await send(broker, { target: '/v1/messages' })).status, 404)
  const models = await send(broker, { target: '/v1/models', method: 'GET' })
  assert.equal(models.status, 200)
  assert.equal(JSON.parse(models.text).data[0].id, 'test-model')
  assert.equal(received.length, 0)
  assert.equal(broker.usage.requestsAdmitted, 0)
})

test('OpenAI requests pin model, output ceiling and one completion while keeping real credentials upstream', async context => {
  const { broker, received, key } = await setup(context, { maxOutputTokens: 32 })
  const result = await send(broker, { body: { ...payload, max_tokens: 9000, max_completion_tokens: 8000, n: 20, best_of: 50, max_output_tokens: 9999 }, headers: { 'x-api-key': 'must-not-be-forwarded', 'x-provider-key': 'must-not-be-forwarded' } })
  assert.equal(result.status, 200)
  assert.equal(received[0].path, '/v1/chat/completions')
  assert.equal(received[0].headers.authorization, `Bearer ${key}`)
  assert.equal(received[0].headers['x-api-key'], undefined)
  assert.equal(received[0].headers['x-provider-key'], undefined)
  assert.equal(received[0].body.model, 'test-model')
  assert.equal(received[0].body.max_completion_tokens, 32)
  assert.equal(received[0].body.max_tokens, undefined)
  assert.equal(received[0].body.max_output_tokens, undefined)
  assert.equal(received[0].body.best_of, undefined)
  assert.equal(received[0].body.n, 1)
  const summary = JSON.stringify(broker.summary())
  assert.equal(summary.includes(key), false)
  assert.equal(summary.includes(broker.clientKey), false)
  assert.equal(summary.includes(payload.messages[0].content), false)
  assert.equal(broker.usage.limits.maxInputBytesPerRequest, 128 * 1024)
})

test('Anthropic compatibility paths keep their configured prefix and clamp max_tokens', async context => {
  const { broker, received, key } = await setup(context, { protocol: 'anthropic', base: '/gateway/anthropic', maxOutputTokens: 20 })
  assert.equal((await send(broker, { target: '/messages', body: { ...payload, max_tokens: 1000 } })).status, 200)
  assert.equal(received[0].path, '/gateway/anthropic/v1/messages')
  assert.equal(received[0].headers['x-api-key'], key)
  assert.equal(received[0].headers.authorization, undefined)
  assert.equal(received[0].headers['anthropic-version'], '2023-06-01')
  assert.equal(received[0].body.max_tokens, 20)
  assert.equal(received[0].body.model, 'test-model')
})

test('parallel calls reserve the request budget atomically and provider errors do not refund it', async context => {
  let release
  const hold = new Promise(resolve => { release = resolve })
  const { broker, received } = await setup(context, { maxRequests: 2 }, async (_request, response) => { await hold; response.writeHead(503).end('private upstream error body') })
  const calls = [send(broker), send(broker), send(broker)]
  while (broker.usage.requestsAdmitted < 2) await new Promise(resolve => setTimeout(resolve, 5))
  release()
  const results = await Promise.all(calls)
  assert.deepEqual(results.map(result => result.status).sort(), [429, 503, 503])
  assert.equal(received.length, 2)
  assert.equal((await send(broker)).status, 429)
  assert.equal(broker.usage.upstreamRequests, 2)
  assert.equal(broker.usage.remainingRequests, 0)
  assert.equal(broker.usage.denied.quota, 2)
  assert.equal(results.some(result => result.text.includes('private upstream error body')), false)
})

test('oversized and malformed bodies consume their admitted slot without reaching a provider', async context => {
  const { broker, received } = await setup(context, { maxInputBytes: 256, maxRequests: 4 })
  assert.equal((await send(broker, { body: { ...payload, messages: [{ role: 'user', content: 'x'.repeat(1024) }] } })).status, 413)
  assert.equal((await send(broker, { body: '{broken' })).status, 400)
  assert.equal((await send(broker, { body: { ...payload, max_tokens: -1 } })).status, 400)
  assert.equal((await send(broker, { headers: { 'content-encoding': 'gzip' } })).status, 400)
  assert.equal(received.length, 0)
  assert.equal(broker.usage.requestsAdmitted, 4)
  assert.equal((await send(broker)).status, 429)
})

test('streaming remains incremental and redacts a real credential split across chunks', async context => {
  let ended = false, key
  const fixture = await setup(context, {}, async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: ' + 'x'.repeat(120) + key.slice(0, 10))
    await new Promise(resolve => setTimeout(resolve, 30))
    response.write(key.slice(10) + '\n\n')
    await new Promise(resolve => setTimeout(resolve, 70))
    ended = true
    response.end('data: [DONE]\n\n')
  })
  key = fixture.key
  const result = await new Promise((resolve, reject) => {
    let firstBeforeEnd = false, text = ''
    const client = request(fixture.broker.url + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${fixture.broker.clientKey}` } }, response => {
      response.on('data', chunk => { if (!text) firstBeforeEnd = !ended; text += chunk })
      response.on('error', reject)
      response.on('end', () => resolve({ text, firstBeforeEnd }))
    })
    client.on('error', reject)
    client.end(JSON.stringify({ ...payload, stream: true }))
  })
  assert.equal(result.firstBeforeEnd, true)
  assert.equal(result.text.includes(key), false)
  assert.match(result.text, /\[REDACTED\]/)
  assert.match(result.text, /\[DONE\]/)
  assert.equal(fixture.broker.usage.requests[0].outcome, 'completed')
})

test('redirects are not followed with a provider credential', async context => {
  const { broker, received } = await setup(context, {}, (_request, response) => response.writeHead(307, { location: '/other-paid-route' }).end())
  assert.equal((await send(broker)).status, 502)
  assert.equal(received.length, 1)
  assert.equal(broker.usage.requests[0].outcome, 'upstream_redirect_refused')
})

test('client cancellation and broker close abort active upstream work', { timeout: 5000 }, async context => {
  let entered, cancelled
  const ready = new Promise(resolve => { entered = resolve })
  const aborted = new Promise(resolve => { cancelled = resolve })
  const { broker } = await setup(context, {}, (_request, response) => { response.once('close', cancelled); entered() })
  const client = request(broker.url + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${broker.clientKey}` } })
  client.on('error', () => {})
  client.end(JSON.stringify(payload))
  await ready
  client.destroy()
  await aborted
  await broker.close()
  await broker.close()
  assert.equal(broker.usage.activeRequests, 0)
  assert.equal(broker.usage.requests[0].outcome, 'client_cancelled')
})

test('request deadlines abort model work and retain a failed budget record', { timeout: 5000 }, async context => {
  const { broker } = await setup(context, { timeoutMs: 40 }, () => {})
  const result = await send(broker)
  assert.equal(result.status, 504)
  assert.equal(broker.usage.requests[0].outcome, 'request_timed_out')
  assert.equal(broker.usage.remainingRequests, 7)
})

test('chunked bodies obey the byte budget even without a Content-Length header', async context => {
  const { broker, received } = await setup(context, { maxInputBytes: 256 })
  const result = await send(broker, { body: JSON.stringify({ ...payload, messages: [{ role: 'user', content: 'x'.repeat(2048) }] }), headers: { 'transfer-encoding': 'chunked' } })
  assert.equal(result.status, 413)
  assert.equal(received.length, 0)
  assert.equal(broker.usage.requests[0].outcome, 'input_budget_exceeded')
  assert.equal(broker.usage.upstreamRequests, 0)
})

test('the deadline also bounds a client that never finishes its request body', { timeout: 5000 }, async context => {
  const { broker, received } = await setup(context, { timeoutMs: 40 })
  const status = await new Promise((resolve, reject) => {
    const client = request(broker.url + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${broker.clientKey}`, 'transfer-encoding': 'chunked' } }, response => {
      response.resume()
      response.once('end', () => { resolve(response.statusCode); client.destroy() })
    })
    client.on('error', reject)
    client.write('{')
  })
  assert.equal(status, 504)
  assert.equal(received.length, 0)
  assert.equal(broker.usage.requests[0].outcome, 'request_timed_out')
})

test('closing an active broker terminates upstream requests before close resolves', { timeout: 5000 }, async context => {
  let entered, cancelled
  const ready = new Promise(resolve => { entered = resolve })
  const stopped = new Promise(resolve => { cancelled = resolve })
  const { broker } = await setup(context, {}, (_request, response) => { response.once('close', cancelled); entered() })
  const response = send(broker).catch(() => null)
  await ready
  await broker.close()
  await stopped
  await response
  assert.equal(broker.usage.requests[0].outcome, 'broker_closed')
  assert.equal(broker.usage.activeRequests, 0)
  assert.ok(broker.usage.requests[0].finishedAt)
})

test('network failures consume an upstream allowance and remain generic in client responses', async context => {
  const { broker, received } = await setup(context, { maxRequests: 1 }, (_request, response) => response.destroy())
  assert.equal((await send(broker)).status, 502)
  assert.equal((await send(broker)).status, 429)
  assert.equal(received.length, 1)
  assert.equal(broker.usage.upstreamRequests, 1)
  assert.equal(broker.usage.requests[0].outcome, 'upstream_failed')
})

test('unsafe upstream URLs and unbounded configuration are rejected before listening', async () => {
  const options = { upstream: 'https://example.invalid/v1', apiKey: 'fake-key', protocol: 'openai', model: 'test-model' }
  for (const upstream of ['http://example.invalid', 'https://user:pass@example.invalid', 'https://example.invalid?key=secret', 'https://example.invalid/v1/chat/completions']) await assert.rejects(startLiveBroker({ ...options, upstream }))
  for (const maxRequests of [0, -1, Infinity, 1.2, 65]) await assert.rejects(startLiveBroker({ ...options, maxRequests }), /maxRequests/)
})
