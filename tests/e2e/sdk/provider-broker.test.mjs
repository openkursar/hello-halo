import test from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { randomUUID } from 'node:crypto'
import { startProviderBroker, liveProviders } from './provider-broker.mjs'

const prompt = { model: 'deepseek-flash', stream: true, messages: [{ role: 'user', content: 'Synthetic test input' }] }

async function setup(t, fetch, provider) {
  const key = `test-credential-${randomUUID()}`
  const upstream = t.mock.method(globalThis, 'fetch', fetch ?? (() => { throw new Error('Unexpected upstream call') }))
  const broker = await startProviderBroker(key, provider)
  t.after(() => broker.close())
  return { key, broker, upstream }
}

function send(broker, { path = '/v1/messages', method = 'POST', body = prompt, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const client = request(broker.url + path, { method, headers }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString() }))
    })
    client.on('error', reject)
    client.end(method === 'GET' ? undefined : JSON.stringify(body))
  })
}

test('unauthenticated requests never reach the provider', async t => {
  const { broker, upstream } = await setup(t)
  assert.equal((await send(broker)).status, 401)
  assert.equal((await send(broker, { headers: { 'x-api-key': 'wrong-token' } })).status, 401)
  assert.equal(upstream.mock.callCount(), 0)
  assert.deepEqual(broker.requests, [])
})

test('the model catalog is local and unsupported models never incur upstream usage', async t => {
  const { broker, upstream } = await setup(t)
  const headers = { authorization: `Bearer ${broker.token}` }
  const catalog = await send(broker, { path: '/v1/models', method: 'GET', headers })
  assert.equal(catalog.status, 200)
  assert.equal(JSON.parse(catalog.text).data[0].id, 'deepseek-flash')
  assert.equal((await send(broker, { path: '/other', headers })).status, 404)
  const rejected = await send(broker, { headers, body: { ...prompt, model: 'unexpected-model' } })
  assert.equal(rejected.status, 502)
  assert.match(rejected.text, /Unexpected model/)
  assert.equal(upstream.mock.callCount(), 0)
})

test('only the upstream gets the real key, including secrets split across response chunks', async t => {
  let key
  const context = await setup(t, async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/anthropic/v1/messages')
    assert.equal(options.headers.get('x-api-key'), key)
    assert.equal(options.headers.get('authorization'), null)
    assert.equal(options.headers.get('x-request-id'), 'synthetic-request')
    assert.deepEqual(JSON.parse(options.body), prompt)
    return new Response(new ReadableStream({
      start(controller) {
        for (const part of ['prefix ', key.slice(0, 9), key.slice(9), ' suffix']) controller.enqueue(Buffer.from(part))
        controller.close()
      },
    }), { headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip', 'content-length': '999' } })
  })
  key = context.key
  const response = await send(context.broker, { headers: {
    'x-api-key': context.broker.token, authorization: 'Bearer discarded', 'x-request-id': 'synthetic-request',
  } })
  assert.equal(response.status, 200)
  assert.equal(response.text, 'prefix [REDACTED] suffix')
  assert.equal(response.headers['content-encoding'], undefined)
  assert.equal(response.headers['content-length'], undefined)
  const report = JSON.stringify(context.broker.requests)
  assert.ok(!report.includes(key))
  assert.ok(!report.includes(context.broker.token))
  assert.ok(!report.includes(prompt.messages[0].content))
  assert.equal(context.broker.requests[0].completed, true)
})

test('provider failures are recorded without exposing the credential', async t => {
  let key
  const context = await setup(t, async () => { throw new Error(`Provider failure: ${key}`) })
  key = context.key
  const response = await send(context.broker, { headers: { 'x-api-key': context.broker.token } })
  assert.equal(response.status, 502)
  assert.match(response.text, /\[REDACTED\]/)
  assert.ok(!response.text.includes(key))
  assert.ok(!JSON.stringify(context.broker.requests).includes(key))
  assert.equal(context.broker.requests[0].completed, false)
})

test('a downstream disconnect cancels its upstream request', { timeout: 5000 }, async t => {
  let entered, aborted
  const ready = new Promise(resolve => { entered = resolve })
  const stopped = new Promise(resolve => { aborted = resolve })
  const { broker } = await setup(t, async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted(); reject(new Error('Request aborted')) }, { once: true })
    entered()
  }))
  const client = request(broker.url + '/v1/messages', { method: 'POST', headers: { 'x-api-key': broker.token } })
  client.on('error', () => {})
  t.after(() => client.destroy())
  client.end(JSON.stringify(prompt))
  await ready
  client.destroy()
  await stopped
  assert.equal(broker.requests[0].completed, false)
})

test('the GLM profile uses its coding endpoint and Bearer authentication', async t => {
  let key
  const context = await setup(t, async (url, options) => {
    assert.equal(url, 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions')
    assert.equal(options.headers.get('authorization'), 'Bearer ' + key)
    assert.equal(options.headers.get('x-api-key'), null)
    assert.equal(JSON.parse(options.body).model, 'glm-5.3-flash')
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }, liveProviders.glm)
  key = context.key
  const headers = { authorization: 'Bearer ' + context.broker.token }
  assert.equal((await send(context.broker, { headers })).status, 404)
  const response = await send(context.broker, { path: '/chat/completions', headers, body: { ...prompt, model: 'glm-5.3-flash' } })
  assert.equal(response.status, 200)
  assert.equal(response.text, 'data: [DONE]\n\n')
  assert.equal(context.upstream.mock.callCount(), 1)
})

test('closing the broker aborts active provider work', { timeout: 5000 }, async t => {
  let entered, aborted
  const ready = new Promise(resolve => { entered = resolve })
  const stopped = new Promise(resolve => { aborted = resolve })
  const { broker } = await setup(t, async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted(); reject(new Error('Broker closed')) }, { once: true })
    entered()
  }))
  const response = send(broker, { headers: { 'x-api-key': broker.token } }).catch(error => error)
  await ready
  await broker.close()
  await stopped
  await response
  assert.equal(broker.requests[0].completed, false)
})
