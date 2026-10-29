import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const entry = fileURLToPath(new URL('../../e2e/fixtures/acceptance-model.ts', import.meta.url))
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-scripted-model-'))
after(() => fs.rm(directory, { recursive: true, force: true }))
const compiled = path.join(directory, 'model.mjs')
await build({ entryPoints: [entry], outfile: compiled, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const { startAcceptanceModel } = await import(pathToFileURL(compiled).href)

for (const protocol of ['anthropic', 'openai']) test(`an intentional ${protocol} provider failure remains distinct from a broken script and can recover`, async context => {
  const model = await startAcceptanceModel()
  context.after(() => model.close())
  const endpoint = protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions'
  const request = () => fetch(model.url + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'synthetic-model', stream: false, messages: [{ role: 'user', content: 'An isolated request' }] }) })
  const failure = { status: 401, type: 'authentication_error', message: 'Synthetic provider rejection' }
  model.respond(() => ({ failure }))
  const rejected = await request()
  assert.equal(rejected.status, 401)
  const body = await rejected.json()
  assert.deepEqual(body.error, protocol === 'anthropic' ? { type: failure.type, message: failure.message } : { type: failure.type, message: failure.message, code: failure.type })
  if (protocol === 'anthropic') assert.equal(body.type, 'error')
  assert.deepEqual(model.errors, [])
  assert.equal(model.exchanges[0].completed, true)
  assert.deepEqual(model.exchanges[0].reply.failure, failure)
  model.respond(() => ({ text: 'The provider recovered' }))
  const recovered = await request()
  assert.equal(recovered.status, 200)
  assert.match(JSON.stringify(await recovered.json()), /The provider recovered/)
  assert.equal(model.exchanges.length, 2)
  assert.deepEqual(model.errors, [])
})

test('invalid scripted failures remain fixture errors rather than deliberate provider responses', async context => {
  const model = await startAcceptanceModel()
  context.after(() => model.close())
  model.respond(() => ({ failure: { status: 200, type: 'invalid', message: 'This is not a rejection' }, text: 'Conflicting success' }))
  const response = await fetch(model.url + '/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Validate the fixture' }] }) })
  assert.equal(response.status, 500)
  assert.equal((await response.json()).error.type, 'script_error')
  assert.equal(model.errors.length, 1)
  assert.equal(model.exchanges[0].completed, false)
})
