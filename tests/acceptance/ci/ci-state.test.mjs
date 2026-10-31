import assert from 'node:assert/strict'
import test from 'node:test'
import { baselineLineages, baselineName, baselineReason, comparableBaseline, findBaselineLineage, findBaselineRun, makeBaseline, renderSummary } from '../../../scripts/acceptance/ci-state.mjs'
import { compareResults } from '../../../scripts/acceptance/lib/quality.mjs'

const revision = 'a'.repeat(40)
const context = { version: 1, repository: 'example/halo', ref: 'main', profile: 'fast', platform: 'darwin', architecture: 'arm64', revision, dirty: false, changedFiles: 0, sdk: { state: 'absent' } }
const complete = executed => ({ complete: true, executed, reasons: [] })
const run = { version: 1, id: 'run-1', finishedAt: '2026-01-01T00:00:00Z', revision: { commit: revision, dirty: false, worktreeHash: 'digest' }, profile: 'fast', platform: 'darwin', catalogHash: 'catalog', manifestHash: 'manifest', status: 'passed', completion: complete(1), selectedCount: 1, excluded: [], cases: [{ caseId: 'example.case', module: 'example', variant: {}, status: 'passed' }], summary: { passed: 1 }, evidenceIntegrity: { version: 1, valid: true, reasons: [] } }

const frozen = (context, run) => ({ freezeSha256: 'f'.repeat(64), receipt: { revision: context.revision, completion: { outcome: 'passed' }, payload: { files: [{ path: 'run/run.json' }] } }, documents: { context, run } })
const baseline = (context, run, previous) => makeBaseline(context, run, frozen(context, run), previous)

test('a complete run advances the baseline whatever its scenarios found, but only when it executed something', () => {
  const record = baseline(context, run)
  assert.equal(record.version, 3)
  assert.equal(record.revision, revision)
  assert.deepEqual(record.results, { 'example.case:{}': 'passed' })
  assert.equal(baselineReason(record, context, () => true), null)

  const mixed = { ...run, status: 'failed', selectedCount: 4, completion: complete(2), cases: ['failed', 'passed', 'blocked', 'manual'].map((status, index) => ({ caseId: `example.case${index}`, module: 'example', variant: {}, status })) }
  assert.deepEqual(Object.values(baseline(context, mixed).results), ['failed', 'passed', 'blocked', 'manual'])

  assert.throws(() => baseline(context, { ...run, completion: complete(0), cases: [{ ...run.cases[0], status: 'blocked' }] }), /executed at least one/)
  assert.throws(() => baseline(context, { ...run, completion: { complete: false, executed: 1, reasons: ['lost results'] } }), /complete run/)
  assert.throws(() => baseline(context, { ...run, completion: undefined }), /complete run/)
  assert.throws(() => baseline(context, { ...run, cases: [{ ...run.cases[0], status: 'not-run' }] }), /Every selected/)
})

test('a baseline needs clean, final, matching evidence of a nonempty run', () => {
  assert.throws(() => baseline(context, { ...run, cases: [], selectedCount: 0 }), /nonempty/)
  assert.throws(() => baseline(context, { ...run, revision: 'b'.repeat(40) }), /revision/)
  assert.throws(() => baseline(context, { ...run, revision: { ...run.revision, dirty: true } }), /revision/)
  assert.throws(() => baseline(context, { ...run, cases: [] }), /Every selected/)
  assert.throws(() => baseline({ ...context, dirty: true }, run), /Source checkout must be clean/)
  for (const evidenceIntegrity of [undefined, { version: 1, valid: false, reasons: ['build changed'] }, { version: 1, valid: true, reasons: ['contradictory evidence'] }, { version: 1, valid: true }]) {
    assert.throws(() => baseline(context, { ...run, evidenceIntegrity }), /evidence integrity/)
  }
})

test('results carry forward for scenarios a run did not select, until the scenario leaves the catalog', () => {
  const first = { ...run, selectedCount: 2, completion: complete(2), excluded: [{ caseId: 'example.other', reason: 'Outside selected modules' }], cases: [
    { caseId: 'example.case', module: 'example', variant: {}, status: 'passed' }, { caseId: 'example.gone', module: 'example', variant: {}, status: 'failed' }] }
  const earlier = baseline(context, first)
  const second = { ...run, excluded: [{ caseId: 'example.other', reason: 'Outside selected modules' }, { caseId: 'example.case', reason: 'x' }], cases: [{ caseId: 'example.fresh', module: 'example', variant: {}, status: 'passed' }] }
  assert.deepEqual(baseline(context, second, earlier).results, { 'example.case:{}': 'passed', 'example.fresh:{}': 'passed' })
})

test('baseline lineages belong to a repository, branch, profile and platform; the SDK and the selection only decide whether changes can be selected from it', () => {
  const record = baseline(context, run)
  for (const key of ['repository', 'ref', 'profile', 'platform', 'architecture']) {
    const other = { ...context, [key]: 'different' }
    assert.notEqual(baselineName(context), baselineName(other))
    assert.match(baselineReason(record, other, () => true), key === 'ref' ? /no baseline of its own/ : /does not match/)
  }
  assert.equal(baselineName(context), baselineName({ ...context, sdk: { state: 'present', revision }, modules: ['teams'], cases: ['example.case'] }))
  assert.match(baselineReason(record, context, () => false), /not an ancestor/)
  assert.match(baselineReason({ ...record, revision: 'main' }, context, () => true), /incomplete/)
  assert.match(baselineReason(record, { ...context, sdk: { state: 'present' } }, () => true), /SDK identity/)
  assert.match(baselineReason(record, { ...context, modules: ['teams'] }, () => true), /scope changed/)
})

test('a branch looks for its own lineage first and then the default branch', () => {
  assert.deepEqual(baselineLineages(context, 'main'), [baselineName(context)])
  assert.deepEqual(baselineLineages({ ...context, ref: 'topic' }, 'main'), [baselineName({ ...context, ref: 'topic' }), baselineName(context)])
  assert.deepEqual(baselineLineages({ ...context, ref: 'topic' }), [baselineName({ ...context, ref: 'topic' })])
})

test('earlier results are comparable across the SDK and catalog, but not across repository, profile, platform or an unrelated branch', () => {
  const record = baseline(context, run)
  assert.equal(comparableBaseline(record, { ...context, sdk: { state: 'present', revision } }, 'main'), record)
  assert.equal(comparableBaseline(record, { ...context, ref: 'topic' }, 'main'), record)
  assert.equal(comparableBaseline(record, { ...context, ref: 'topic' }, 'release'), null)
  for (const key of ['repository', 'profile', 'platform', 'architecture']) assert.equal(comparableBaseline(record, { ...context, [key]: 'different' }, 'main'), null)
  for (const unusable of [null, { ...record, version: 2 }, { ...record, results: undefined }, { ...record, results: [] }, { ...record, results: {} }, { ...record, runId: undefined }]) {
    assert.equal(comparableBaseline(unusable, context, 'main'), null)
  }
})

test('unknown or modified SDK builds cannot become reproducibility baselines', () => {
  for (const sdk of [
    { state: 'present', revision: null, dirty: null, buildHash: 'digest' },
    { state: 'present', revision, dirty: true, buildHash: 'digest' },
    { state: 'present', revision, dirty: false, buildHash: null },
  ]) assert.throws(() => baseline({ ...context, sdk }, run), /SDK source/)
  assert.equal(baseline({ ...context, sdk: { state: 'present', revision, dirty: false, buildHash: 'digest' } }, run).sdk.revision, revision)
})

test('a module or case selection can be compared but cannot advance the baseline', () => {
  const scopedContext = { ...context, modules: ['teams'], cases: [] }
  const scopedRun = { ...run, selection: { modules: ['teams'], cases: [] } }
  assert.throws(() => baseline(scopedContext, scopedRun), /cannot advance/)
  assert.throws(() => baseline({ ...context, cases: ['example.case'] }, run), /cannot advance/)
  assert.throws(() => baseline(context, scopedRun), /scope differs/)
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

test('the first lineage with a successful run supplies the baseline', async () => {
  const request = async url => {
    const name = decodeURIComponent(/name=([^&]+)/.exec(url)?.[1] ?? '')
    const body = url.includes('/artifacts?')
      ? { artifacts: name === 'default-lineage' ? [{ id: 9, name, workflow_run: { id: 9 } }] : [] }
      : { id: 9, status: 'completed', conclusion: 'success', path: '.github/workflows/acceptance.yml' }
    return { ok: true, json: async () => body }
  }
  const lookup = { repository: 'example/controller', workflowPath: '.github/workflows/acceptance.yml', token: 'test-token', request }
  assert.deepEqual(await findBaselineLineage({ ...lookup, names: ['own-lineage', 'default-lineage'] }), { runId: '9', artifactName: 'default-lineage' })
  assert.equal(await findBaselineLineage({ ...lookup, names: ['own-lineage'] }), null)
})

test('missing run evidence is visibly blocked and CI outcomes remain separate', () => {
  const text = renderSummary(context, null, { install: { outcome: 'failure' }, execute: { outcome: 'skipped' } })
  assert.match(text, /blocked before/)
  assert.match(text, /install \| failure/)
  assert.match(text, /execute \| skipped/)
  assert.doesNotMatch(text, /\[object Object\]/)
})

test('the summary leads with what changed in quality and keeps an incomplete run from reading as clean', () => {
  const previous = baseline(context, { ...run, cases: [{ ...run.cases[0], status: 'passed' }] })
  const failing = { ...run, status: 'failed', summary: { failed: 1 }, cases: [{ ...run.cases[0], title: { en: 'Example journey' }, status: 'failed' }] }
  const quality = compareResults(failing, previous)
  const text = renderSummary({ ...context, sdk: { state: 'present', revision: 'c'.repeat(40) } }, failing, {}, quality)
  assert.match(text, /### Quality\n\n\*\*1 new failure\*\*/)
  assert.match(text, /Halo SDK: `c{40}`/)
  assert.match(text, /Run: \*\*complete\*\*/)
  const partial = renderSummary(context, { ...failing, completion: { complete: false, executed: 0, reasons: ['lost results'] } }, {}, quality)
  assert.match(partial, /This run is incomplete; the findings below are partial\./)
  assert.match(partial, /Run: \*\*incomplete\*\* · Selected instances: 1 · lost results/)
})

test('baseline advancement requires matching final frozen documents and rejects legacy baselines', () => {
  assert.throws(() => makeBaseline(context, run), /Final frozen evidence/)
  assert.throws(() => makeBaseline(context, run, { ...frozen(context, run), freezeSha256: 'invalid' }), /Final frozen evidence/)
  assert.throws(() => makeBaseline(context, run, { ...frozen(context, run), documents: { context, run: { ...run, id: 'different' } } }), /exact frozen context/)
  assert.match(baselineReason({ ...baseline(context, run), version: 2 }, context, () => true), /No supported frozen/)
})
