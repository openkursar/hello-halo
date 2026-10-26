import assert from 'node:assert/strict'
import test from 'node:test'
import { baselineName, baselineReason, findBaselineRun, makeBaseline, renderSummary } from '../../../scripts/acceptance/ci-state.mjs'

const revision = 'a'.repeat(40)
const context = { version: 1, repository: 'example/halo', ref: 'main', profile: 'fast', platform: 'darwin', architecture: 'arm64', revision, dirty: false, changedFiles: 0, sdk: { state: 'absent' } }
const run = { version: 1, id: 'run-1', finishedAt: '2026-01-01T00:00:00Z', revision: { commit: revision, dirty: false, worktreeHash: 'digest' }, profile: 'fast', platform: 'darwin', catalogHash: 'catalog', manifestHash: 'manifest', status: 'passed', selectedCount: 1, cases: [{ caseId: 'example.case', variant: {}, status: 'passed' }], summary: { passed: 1 }, evidenceIntegrity: { version: 1, valid: true, reasons: [] } }

test('only complete nonempty matching passing evidence advances a baseline', () => {
  const baseline = makeBaseline(context, run)
  assert.equal(baseline.revision, revision)
  assert.equal(baselineReason(baseline, context, () => true), null)
  for (const status of ['failed', 'flaky', 'skipped', 'blocked', 'not-run', 'manual']) {
    assert.throws(() => makeBaseline(context, { ...run, cases: [{ ...run.cases[0], status }] }), /Every selected/)
  }
  assert.throws(() => makeBaseline(context, { ...run, cases: [], selectedCount: 0 }), /nonempty/)
  assert.throws(() => makeBaseline(context, { ...run, revision: 'b'.repeat(40) }), /revision/)
  assert.throws(() => makeBaseline(context, { ...run, revision: { ...run.revision, dirty: true } }), /revision/)
  assert.throws(() => makeBaseline(context, { ...run, cases: [] }), /Every selected/)
  assert.throws(() => makeBaseline({ ...context, dirty: true }, run), /Source checkout must be clean/)
  for (const evidenceIntegrity of [undefined, { version: 1, valid: false, reasons: ['build changed'] }, { version: 1, valid: true, reasons: ['contradictory evidence'] }, { version: 1, valid: true }]) {
    assert.throws(() => makeBaseline(context, { ...run, evidenceIntegrity }), /evidence integrity/)
  }
})

test('baseline reuse is scoped to repository, branch, profile, platform and SDK identity', () => {
  const baseline = makeBaseline(context, run)
  for (const key of ['repository', 'ref', 'profile', 'platform', 'architecture']) {
    const other = { ...context, [key]: 'different' }
    assert.notEqual(baselineName(context), baselineName(other))
    assert.match(baselineReason(baseline, other, () => true), /does not match/)
  }
  assert.match(baselineReason(baseline, context, () => false), /not an ancestor/)
  assert.match(baselineReason({ ...baseline, revision: 'main' }, context, () => true), /incomplete/)
  assert.match(baselineReason(baseline, { ...context, sdk: { state: 'present' } }, () => true), /SDK identity/)
})

test('unknown or modified SDK builds cannot become reproducibility baselines', () => {
  for (const sdk of [
    { state: 'present', revision: null, dirty: null, buildHash: 'digest' },
    { state: 'present', revision, dirty: true, buildHash: 'digest' },
    { state: 'present', revision, dirty: false, buildHash: null },
  ]) assert.throws(() => makeBaseline({ ...context, sdk }, run), /SDK source/)
  assert.equal(makeBaseline({ ...context, sdk: { state: 'present', revision, dirty: false, buildHash: 'digest' } }, run).sdk.revision, revision)
})

test('a module-only pass cannot advance or replace a full-profile baseline', () => {
  const scopedContext = { ...context, modules: ['teams'], cases: [] }
  const scopedRun = { ...run, selection: { modules: ['teams'], cases: [] } }
  const baseline = makeBaseline(scopedContext, scopedRun)
  assert.notEqual(baselineName(scopedContext), baselineName(context))
  assert.match(baselineReason(baseline, context, () => true), /scope changed/)
  assert.throws(() => makeBaseline(context, scopedRun), /scope differs/)
})

test('artifact lookup ignores failed runs, other workflows and expired evidence', async () => {
  const requests = []
  const request = async url => {
    requests.push(url)
    let body
    if (url.includes('/artifacts?')) body = { artifacts: [
      { id: 5, name: 'baseline', expired: true, workflow_run: { id: 5 } },
      { id: 4, name: 'baseline', workflow_run: { id: 4 } },
      { id: 3, name: 'baseline', workflow_run: { id: 3 } },
      { id: 2, name: 'baseline', workflow_run: { id: 2 } },
    ] }
    else {
      const id = Number(url.split('/').pop())
      body = { id, status: 'completed', conclusion: id === 4 ? 'failure' : 'success', path: id === 3 ? '.github/workflows/another.yml' : '.github/workflows/acceptance.yml' }
    }
    return { ok: true, json: async () => body }
  }
  const id = await findBaselineRun({ repository: 'example/controller', artifactName: 'baseline', workflowPath: '.github/workflows/acceptance.yml', token: 'test-token', request })
  assert.equal(id, '2')
  assert.equal(requests.length, 4)
  assert.equal(requests.some(url => url.endsWith('/5')), false)
})

test('missing run evidence is visibly blocked and CI outcomes remain separate', () => {
  const text = renderSummary(context, null, { install: { outcome: 'failure' }, execute: { outcome: 'skipped' } })
  assert.match(text, /blocked before/)
  assert.match(text, /install \| failure/)
  assert.match(text, /execute \| skipped/)
  assert.doesNotMatch(text, /\[object Object\]/)
})
