import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('./run-live.mjs', import.meta.url))
const env = { ...process.env }
delete env.SDK_TEST_API_KEY

function run(args = [], input = '') {
  const result = spawnSync(process.execPath, [entry, ...args], { env, input, encoding: 'utf8', timeout: 3000 })
  assert.equal(result.error, undefined)
  return { status: result.status, output: result.stdout + result.stderr }
}

test('help needs no credential and does not start a build', () => {
  const result = run(['--help'])
  assert.equal(result.status, 0)
  assert.match(result.output, /application acceptance/)
  assert.doesNotMatch(result.output, /Isolated Halo/)
})

test('a missing credential fails instead of skipping the live suite', () => {
  const result = run()
  assert.notEqual(result.status, 0)
  assert.match(result.output, /live integration never skips/)
})

test('unknown flags cannot silently select unintended behavior', () => {
  const result = run(['--key-stdni'])
  assert.notEqual(result.status, 0)
  assert.match(result.output, /Unknown option/)
})

test('closed or blank stdin fails without hanging or starting a build', () => {
  for (const input of ['', '  \n']) {
    const result = run(['--key-stdin'], input)
    assert.notEqual(result.status, 0)
    assert.match(result.output, /live integration never skips/)
    assert.doesNotMatch(result.output, /Isolated Halo/)
  }
})
