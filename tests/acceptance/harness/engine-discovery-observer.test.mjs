import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

const source = readFileSync(new URL('../../e2e/fixtures/engine-discovery-observer.cjs', import.meta.url), 'utf8')

test('runtime observation preserves calls and errors and records the initiating stack', async () => {
  const calls = []
  const failure = new Error('missing selected installation')
  const result = Promise.reject(failure)
  result.catch(() => {})
  const promises = Object.fromEntries(['stat', 'access', 'realpath', 'open', 'opendir'].map(operation => [operation, function (...args) {
    calls.push({ operation, receiver: this, args })
    return result
  }]))
  let evidence
  let synchronized = 0
  const modules = {
    'node:fs': { readFileSync: () => JSON.stringify({ agent: { ccRuntime: { selectedPath: '/isolated/absent-automatic-cc' } } }), writeFileSync: (_path, body) => { evidence = JSON.parse(body) } },
    'node:fs/promises': promises,
    'node:module': { syncBuiltinESMExports: () => { synchronized++ } },
    'node:path': { join },
  }
  vm.runInNewContext(source, { require: name => modules[name], process: { pid: 123, env: { HALO_DATA_DIR: '/isolated' } } })
  function initiatingRuntimeCheck() { return promises.stat('/isolated/absent-automatic-cc', { bigint: true }) }
  const observed = initiatingRuntimeCheck()
  assert.equal(observed, result)
  await assert.rejects(observed, error => error === failure)
  assert.equal(calls[0].receiver, promises)
  assert.deepEqual(calls[0].args, ['/isolated/absent-automatic-cc', { bigint: true }])
  assert.equal(evidence.pid, 123)
  assert.equal(evidence.operations.length, 1)
  assert.match(evidence.operations[0].stack, /initiatingRuntimeCheck/)
  assert.equal(synchronized, 1)
  promises.stat('/isolated/unrelated')
  assert.equal(evidence.operations.length, 1)
  for (let index = 0; index < 1024; index++) promises.stat('/isolated/absent-automatic-cc')
  assert.equal(evidence.operations.length, 1024)
  assert.equal(evidence.truncated, true)
})
