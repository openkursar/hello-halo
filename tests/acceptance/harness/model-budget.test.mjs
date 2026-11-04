import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { prerequisiteFailures } from '../../../scripts/acceptance/lib/execution.mjs'

test('anthropic variants require an explicitly supplied external engine, without blocking halo variants on CC', async () => {
  const previous = process.env.HALO_ACCEPTANCE_CLAUDE_CLI
  delete process.env.HALO_ACCEPTANCE_CLAUDE_CLI
  try {
    assert.deepEqual(await prerequisiteFailures(process.cwd(), { variant: { engine: 'anthropic' } }), ['A separately installed external command-line engine was not configured'])
    const halo = await prerequisiteFailures(process.cwd(), { variant: { engine: 'halo' } })
    assert(halo.every(problem => !problem.includes('external command-line')))
    process.env.HALO_ACCEPTANCE_CLAUDE_CLI = '/nonexistent/acceptance-model-budget-cc'
    assert.deepEqual(await prerequisiteFailures(process.cwd(), { variant: { engine: 'anthropic' } }), ['The configured external command-line engine does not exist'])
  } finally {
    if (previous === undefined) delete process.env.HALO_ACCEPTANCE_CLAUDE_CLI
    else process.env.HALO_ACCEPTANCE_CLAUDE_CLI = previous
  }
})

test('budget observation forwards engine inputs unchanged and retains only budget metadata', () => {
  const calls = []
  class Worker { postMessage(...args) { calls.push(args); return 42 } }
  class ChildProcess { spawn(...args) { calls.push(args); return 43 } }
  const context = vm.createContext({ require: name => name === 'node:worker_threads' ? { Worker } : { ChildProcess } })
  vm.runInContext(readFileSync(new URL('../../e2e/fixtures/model-budget-observer.cjs', import.meta.url), 'utf8'), context)
  const message = { type: 'request', method: 'create', value: { encoded: { options: { model: 'future', contextWindow: 200000, maxOutputTokens: 64000, apiKey: 'private', systemPrompt: 'private' } } } }
  assert.equal(new Worker().postMessage(message), 42)
  const options = { envPairs: ['CLAUDE_CODE_AUTO_COMPACT_WINDOW=128000', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS=32000', 'API_KEY=private'] }
  assert.equal(new ChildProcess().spawn(options), 43)
  assert.equal(calls[0][0], message)
  assert.equal(calls[1][0], options)
  assert.deepEqual(JSON.parse(JSON.stringify(context.modelBudgetObservations)), [
    { engine: 'halo', model: 'future', contextWindow: 200000, maxOutputTokens: 64000 },
    { engine: 'anthropic', contextWindow: 128000, maxOutputTokens: 32000 },
  ])
})
