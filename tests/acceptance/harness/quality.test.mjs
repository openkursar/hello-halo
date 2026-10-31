import test from 'node:test'
import assert from 'node:assert/strict'
import { compareResults, failingCaseIds, nextResults, renderQuality, resultKey } from '../../../scripts/acceptance/lib/quality.mjs'
import { runCompletion } from '../../../scripts/acceptance/lib/execution.mjs'
import { instanceKey } from '../../../scripts/acceptance/lib/catalog.mjs'

const item = (caseId, status, extra = {}) => ({ caseId, module: caseId.split('.')[0], title: { en: `Title of ${caseId}`, zh: caseId }, variant: {}, status, ...extra })
const earlier = results => ({ results, ref: 'main', revision: 'b'.repeat(40), runId: 'earlier', completedAt: '2026-10-30T19:23:00Z' })
const run = (...cases) => ({ cases, excluded: [] })

test('a result is new, continuing, fixed or lost depending on what was known before', () => {
  const previous = earlier({
    [resultKey(item('chat.a'))]: 'passed', [resultKey(item('chat.b'))]: 'failed', [resultKey(item('chat.c'))]: 'failed', [resultKey(item('teams.d'))]: 'passed',
    [resultKey(item('teams.e'))]: 'blocked', [resultKey(item('teams.f'))]: 'passed',
  })
  const quality = compareResults(run(
    item('chat.a', 'failed'), item('chat.b', 'failed'), item('chat.c', 'passed'), item('teams.d', 'blocked'),
    item('teams.e', 'passed'), item('teams.f', 'passed'), item('teams.g', 'failed'), item('teams.h', 'skipped'),
  ), previous)
  assert.deepEqual(quality.newFailures.map(entry => [entry.caseId, entry.previous]), [['chat.a', 'passed'], ['teams.g', null]])
  assert.deepEqual(quality.stillFailing.map(entry => entry.caseId), ['chat.b'])
  assert.deepEqual(quality.fixed.map(entry => entry.caseId), ['chat.c'])
  assert.deepEqual(quality.lostCoverage.map(entry => entry.caseId), ['teams.d'])
  assert.equal(quality.counts.newlyCovered, 1)
  assert.deepEqual(quality.counts, { selected: 8, passed: 3, failed: 3, flaky: 0, blocked: 1, manual: 0, skipped: 1, notRun: 0, newlyCovered: 1, uncovered: 2 })
  assert.deepEqual(quality.uncoveredByModule, { teams: 2 })
  assert.deepEqual(quality.comparedWith, { ref: 'main', revision: 'b'.repeat(40), runId: 'earlier', completedAt: '2026-10-30T19:23:00Z' })
})

test('without earlier results nothing is called new and uncovered scenarios are never failures', () => {
  const quality = compareResults(run(item('chat.a', 'failed'), item('chat.b', 'passed'), item('chat.c', 'blocked')), null)
  assert.equal(quality.comparedWith, null)
  assert.deepEqual(quality.failingNow.map(entry => entry.caseId), ['chat.a'])
  assert.equal(quality.newFailures.length + quality.stillFailing.length + quality.lostCoverage.length, 0)
  assert.equal(quality.counts.uncovered, 1)
})

test('an unstable scenario is listed on its own and a scenario with no result is called out', () => {
  const quality = compareResults(run(item('chat.a', 'flaky'), item('chat.b', 'not-run', { reason: 'Required test results were not produced' })), earlier({}))
  assert.deepEqual(quality.unstable.map(entry => entry.caseId), ['chat.a'])
  assert.deepEqual(quality.notRun.map(entry => [entry.caseId, entry.reason]), [['chat.b', 'Required test results were not produced']])
})

test('failure reasons are one line without colors or local paths', () => {
  const error = '\u001b[31mError: expected /Users/someone/project/file.ts to exist\u001b[39m\n  at somewhere'
  const quality = compareResults(run(item('chat.a', 'failed', { attempts: [{ errors: [] }, { errors: [error, 'later'] }] })), null)
  assert.equal(quality.failingNow[0].reason, 'Error: expected <path> to exist')
  assert.match(compareResults(run(item('chat.a', 'failed', { attempts: [{ errors: ['x'.repeat(500)] }] })), null).failingNow[0].reason, /^x{197}\.\.\.$/)
})

test('results carry forward only for scenarios that still exist, and previously failing scenarios are the ones to select again', () => {
  const previous = { [resultKey(item('chat.a'))]: 'failed', [resultKey(item('chat.old'))]: 'failed', [resultKey(item('teams.b'))]: 'flaky', [resultKey(item('teams.c'))]: 'passed' }
  const next = nextResults(previous, { cases: [item('chat.d', 'passed')], excluded: [{ caseId: 'chat.a' }, { caseId: 'teams.b' }, { caseId: 'teams.c' }] })
  assert.deepEqual(next, { [resultKey(item('chat.a'))]: 'failed', [resultKey(item('teams.b'))]: 'flaky', [resultKey(item('teams.c'))]: 'passed', [resultKey(item('chat.d'))]: 'passed' })
  assert.deepEqual(failingCaseIds(next), ['chat.a', 'teams.b'])
  assert.deepEqual(failingCaseIds(undefined), [])
})

test('the summary names new failures first and keeps long lists short', () => {
  const many = Array.from({ length: 60 }, (_, index) => item(`chat.n${index}`, 'failed'))
  const text = renderQuality(compareResults(run(...many, item('chat.fixed', 'passed'), item('teams.x', 'blocked')), earlier({ [resultKey(item('chat.fixed'))]: 'failed' })), { limit: 5 }).join('\n')
  assert.match(text, /^### Quality\n\n\*\*60 new failures\*\* · 1 fixed · 0 still failing · 1 not covered/)
  assert.match(text, /Compared with `bbbbbbbb` on `main`, 2026-10-30\./)
  assert.match(text, /#### New failures\n\n- `chat\.n0` — Title of chat\.n0 \(chat\)/)
  assert.match(text, /… and 55 more in quality\.json/)
  assert.match(text, /<summary>Fixed \(1\)<\/summary>/)
  assert.match(text, /<summary>Not covered \(1\)/)
  assert.doesNotMatch(text, /\n#### Failing\n/)
})

test('a quiet run says so and an uncompared run explains itself', () => {
  const quiet = renderQuality(compareResults(run(item('chat.a', 'passed')), earlier({ [resultKey(item('chat.a'))]: 'passed' }))).join('\n')
  assert.match(quiet, /\*\*No new failures\*\* · 0 fixed · 0 still failing · 0 not covered/)
  const alone = renderQuality(compareResults(run(item('chat.a', 'failed', { variant: { member: 'lead' } })), null)).join('\n')
  assert.match(alone, /\*\*1 failing\*\* · 0 passing/)
  assert.match(alone, /No earlier result to compare with/)
  assert.match(alone, /#### Failing\n\n- `chat\.a` member=lead —/)
})

test('markdown from titles and reasons cannot break out of the summary', () => {
  const text = renderQuality(compareResults(run(item('chat.a', 'failed', { title: { en: 'a | `b` <script>' }, reason: 'x' })), null)).join('\n')
  assert.doesNotMatch(text, /<script>|\| `b`/)
})

test('a run is complete when everything it executed has a result, whatever those results are', () => {
  const cases = status => [{ status: 'passed' }, { status }]
  assert.deepEqual(runCompletion({ cases: cases('failed'), errors: [], runnerFailed: false }), { complete: true, executed: 2, reasons: [] })
  assert.deepEqual(runCompletion({ cases: cases('blocked'), errors: [], runnerFailed: false }), { complete: true, executed: 1, reasons: [] })
  assert.deepEqual(runCompletion({ cases: [{ status: 'manual' }], errors: [], runnerFailed: false }), { complete: true, executed: 0, reasons: [] })
  assert.deepEqual(runCompletion({ cases: cases('skipped'), errors: [], runnerFailed: false }).complete, true)
})

test('a run that lost results, failed its integrity checks, never selected anything or broke the runner is incomplete', () => {
  assert.match(runCompletion({ cases: [{ status: 'passed' }, { status: 'not-run' }], errors: [], runnerFailed: false }).reasons.join(), /1 selected scenario produced no result/)
  assert.match(runCompletion({ cases: [{ status: 'passed' }], errors: ['changed'], runnerFailed: false }).reasons.join(), /integrity/)
  assert.match(runCompletion({ cases: [], errors: [], runnerFailed: false }).reasons.join(), /no scenario/)
  assert.match(runCompletion({ cases: [{ status: 'passed' }], errors: [], runnerFailed: true }).reasons.join(), /runner/)
  for (const input of [{ cases: [{ status: 'not-run' }], errors: [], runnerFailed: false }, { cases: [], errors: [], runnerFailed: false }]) assert.equal(runCompletion(input).complete, false)
})

test('a result key is the catalog instance key, whatever the order of the variant fields', () => {
  for (const variant of [{}, { member: 'lead' }, { platform: 'darwin', member: 'ordinary' }, { nested: { b: 1, a: [{ d: 1, c: 2 }] } }]) {
    assert.equal(resultKey({ caseId: 'chat.a', variant }), instanceKey('chat.a', variant))
  }
  assert.equal(resultKey({ caseId: 'chat.a' }), instanceKey('chat.a', {}))
  assert.equal(resultKey({ caseId: 'chat.a', variant: { b: 1, a: 2 } }), resultKey({ caseId: 'chat.a', variant: { a: 2, b: 1 } }))
})
