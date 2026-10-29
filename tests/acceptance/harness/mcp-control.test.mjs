import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import test, { after } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const directory = await mkdtemp(join(tmpdir(), 'acceptance-mcp-control-'))
after(() => rm(directory, { recursive: true, force: true }))
const compiled = join(directory, 'fixture.mjs')
await build({ entryPoints: [fileURLToPath(new URL('../../e2e/fixtures/acceptance-mcp.ts', import.meta.url))], outfile: compiled, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const { startAcceptanceMcp } = await import(pathToFileURL(compiled).href)

async function connect(service) {
  const client = new Client({ name: 'local-protocol-check', version: '1.0.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url)))
    return client
  } catch (error) {
    await client.close()
    throw error
  }
}

async function waitForCall(service, value) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const exchange = service.exchanges.find(item => item.method === 'tools/call' && item.value === value)
    if (exchange) return exchange
    await setTimeout(10)
  }
  assert.fail('The real MCP request did not arrive')
}

test('records the failed RPC identity and lets the same real HTTP client call after recovery', async () => {
  const service = await startAcceptanceMcp()
  let client
  try {
    client = await connect(service)
    assert.equal((await client.listTools()).tools[0].name, 'echo_acceptance')
    service.setAvailable(false)
    await assert.rejects(client.callTool({ name: 'echo_acceptance', arguments: { value: 'unavailable-call' } }), /Acceptance MCP service unavailable/)
    const rejected = await waitForCall(service, 'unavailable-call')
    assert.deepEqual({ status: rejected.status, completed: rejected.completed, cancelled: rejected.cancelled }, { status: 503, completed: true, cancelled: false })
    assert.deepEqual(service.calls, [])
    service.setAvailable(true)
    const result = await client.callTool({ name: 'echo_acceptance', arguments: { value: 'recovered-call' } })
    assert.deepEqual(result, { content: [{ type: 'text', text: 'Service receipt: recovered-call' }], isError: false })
    assert.deepEqual(service.calls, [{ value: 'recovered-call', failed: false }])
  } finally {
    try { await client?.close() } finally { await service.close() }
  }
})

test('holds the real response without inventing completion and releases the original operation', async () => {
  const service = await startAcceptanceMcp()
  let client
  try {
    client = await connect(service)
    const held = service.holdNextToolCall()
    let settled = false
    const result = client.callTool({ name: 'echo_acceptance', arguments: { value: 'held-call' } }).finally(() => { settled = true })
    const exchange = await waitForCall(service, 'held-call')
    assert.equal(settled, false)
    assert.deepEqual({ status: exchange.status, completed: exchange.completed, cancelled: exchange.cancelled }, { status: null, completed: false, cancelled: false })
    service.failTools(true)
    held.release()
    assert.deepEqual(await result, { content: [{ type: 'text', text: 'Service receipt: held-call' }], isError: false })
    assert.equal(exchange.completed, true)
    assert.equal(exchange.cancelled, false)
    assert.deepEqual(service.calls, [{ value: 'held-call', failed: false }])
  } finally {
    try { await client?.close() } finally { await service.close() }
  }
})

test('closing the owned service cancels an outstanding tool response and releases every hold', async () => {
  const service = await startAcceptanceMcp()
  let client
  let closed = false
  try {
    client = await connect(service)
    service.holdNextToolCall()
    const result = client.callTool({ name: 'echo_acceptance', arguments: { value: 'cancelled-call' } })
    const rejected = assert.rejects(result)
    const exchange = await waitForCall(service, 'cancelled-call')
    await service.close()
    closed = true
    await rejected
    for (let attempt = 0; attempt < 100 && !exchange.cancelled; attempt++) await setTimeout(10)
    assert.equal(exchange.cancelled, true)
    assert.equal(exchange.completed, false)
  } finally {
    try { await client?.close() } finally { if (!closed) await service.close() }
  }
})
