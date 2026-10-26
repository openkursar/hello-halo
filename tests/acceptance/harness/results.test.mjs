import test from 'node:test'
import assert from 'node:assert/strict'
import { collectResults, summarizeCases } from '../../../scripts/acceptance/lib/execution.mjs'

const binding = { caseId: 'chat.reply', evidence: 'app-e2e', mode: 'scripted', variant: {} }
const plan = { tests: ['a', 'b'].map(id => ({ id, bindings: [binding] })), cases: [{ caseId: 'chat.reply', variant: {}, automation: 'automated', testIds: ['a', 'b'] }] }
const event = (id, status, retry = 0) => ({ type: 'test', id, status, retry, bindings: [binding] })

test('a story outcome requires all of its bound tests, including missing results', () => {
  const results = collectResults(plan, [event('a', 'passed')], {})
  assert.equal(results[0].status, 'not-run')
  assert.equal(summarizeCases(results).passed, 0)
})

test('a retry cannot erase an earlier failure', () => {
  const results = collectResults(plan, [event('a', 'failed'), event('a', 'passed', 1), event('b', 'passed')], {})
  assert.equal(results[0].status, 'flaky')
  assert.equal(results[0].attempts.length, 3)
})

test('skipped, blocked and manual checks never count as passing', () => {
  const cases = [{ ...plan.cases[0], testIds: ['a'] }, { ...plan.cases[0], caseId: 'blocked', blockedReason: 'No environment' }, { ...plan.cases[0], caseId: 'manual', automation: 'manual' }]
  const results = collectResults({ ...plan, cases }, [event('a', 'skipped')], {})
  assert.deepEqual(results.map(result => result.status), ['skipped', 'blocked', 'manual'])
})

test('an expected test failure is still an unfulfilled product promise', () => {
  const results = collectResults(plan, [{ ...event('a', 'failed'), expectedStatus: 'failed' }, event('b', 'passed')], {})
  assert.equal(results[0].status, 'failed')
})

test('a stale case binding cannot borrow a pass from the same test identifier', () => {
  const results = collectResults(plan, [{ ...event('a', 'passed'), bindings: [{ ...binding, caseId: 'chat.other' }] }, event('b', 'passed')], {})
  assert.equal(results[0].status, 'not-run')
  assert.match(results[0].reason, /Actual test bindings differ/)
})
