import test from 'node:test'
import assert from 'node:assert/strict'
import { executionBatches, verifyLiveEvidence } from '../../../scripts/acceptance/lib/execution.mjs'

test('large selections are bounded and retain every executable test exactly once', () => {
  const tests = Array.from({ length: 2000 }, (_, index) => ({ id: String(index), titlePath: ['project', 'file', 'A user-visible story ' + index], file: 'tests/e2e/specs/example.spec.ts', project: 'acceptance' }))
  const batches = executionBatches(tests)
  assert(batches.length > 1)
  assert.deepEqual(batches.flat().map(item => item.id), tests.map(item => item.id))
  for (const batch of batches) assert(batch.reduce((sum, item) => sum + Buffer.byteLength(item.titlePath.join(' ') + item.file + item.project) * 2 + 64, 0) <= 8192)
})

test('a live case cannot borrow another test window or an unisolated profile', () => {
  const start = Date.parse('2026-01-01T00:00:00Z')
  const scenario = { mode: 'live', status: 'passed', testIds: ['a'], attempts: [{ id: 'a', startedAt: new Date(start).toISOString(), duration: 1000, isolation: ['brokered-fresh-profile'] }] }
  const receipt = { sequence: 1, startedAt: new Date(start + 500).toISOString(), upstreamStatus: 200, responseBytes: 20 }
  assert.equal(verifyLiveEvidence([scenario], { requests: [receipt] })[0].status, 'passed')
  assert.equal(verifyLiveEvidence([scenario], { requests: [{ ...receipt, startedAt: new Date(start - 5000).toISOString() }] })[0].status, 'not-run')
  assert.equal(verifyLiveEvidence([{ ...scenario, attempts: [{ ...scenario.attempts[0], isolation: [] }] }], { requests: [receipt] })[0].status, 'not-run')
})
