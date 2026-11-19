import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const observer = readFileSync(new URL('../../e2e/fixtures/model-budget-observer.cjs', import.meta.url), 'utf8')

function harness(loader) {
  class Worker { postMessage() {} }
  class ChildProcess { spawn() {} }
  const process = { dlopen: loader ?? function (module, exports) { module.exports = exports; return 'loaded' } }
  const context = vm.createContext({ process, require: name => name === 'node:worker_threads' ? { Worker } : { ChildProcess } })
  vm.runInContext(observer, context)
  return { context, process }
}

test('native observation forwards constructor arguments, identity and lifecycle without retaining secrets', () => {
  const { context, process } = harness()
  let received
  class NativeSession {
    constructor(...args) { received = args; this.closed = false }
    close() { this.closed = true }
  }
  const module = {}
  assert.equal(process.dlopen(module, { NativeSession }), 'loaded')
  const release = () => {}
  const options = JSON.stringify({ model: 'local-model', contextWindow: 300000, maxOutputTokens: 96000, apiKey: 'never-record', prompt: 'never-record' })
  const instance = new module.exports.NativeSession(options, release)
  assert.deepEqual(received, [options, release])
  assert.equal(Object.getPrototypeOf(instance), NativeSession.prototype)
  assert.ok(instance instanceof NativeSession)
  assert.ok(instance instanceof module.exports.NativeSession)
  instance.close()
  assert.equal(instance.closed, true)
  assert.deepEqual(JSON.parse(JSON.stringify(context.modelBudgetObservations)), [{ engine: 'halo', boundary: 'native-session', model: 'local-model', contextWindow: 300000, maxOutputTokens: 96000 }])
})

test('native constructor failure is preserved', () => {
  const { context, process } = harness()
  const failure = new Error('native refused')
  class NativeSession { constructor() { throw failure } }
  const module = {}
  process.dlopen(module, { NativeSession })
  assert.throws(() => new module.exports.NativeSession('{"model":"local"}'), error => error === failure)
  assert.equal(context.modelBudgetObservations.length, 0)
})

test('loader failure is preserved without recording a session', () => {
  const failure = new Error('addon unavailable')
  const { context, process } = harness(() => { throw failure })
  assert.throws(() => process.dlopen({}), error => error === failure)
  assert.equal(context.modelBudgetObservations.length, 0)
})

test('unrelated addons are untouched', () => {
  const { process } = harness()
  const exports = { OtherNativeSession: class {} }
  const module = {}
  assert.equal(process.dlopen(module, exports), 'loaded')
  assert.equal(module.exports, exports)
  assert.equal(module.exports.OtherNativeSession, exports.OtherNativeSession)
})
