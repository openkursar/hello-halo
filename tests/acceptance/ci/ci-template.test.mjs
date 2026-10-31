import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { parse } from 'yaml'

const workflow = parse(fs.readFileSync(new URL('./acceptance.yml', import.meta.url), 'utf8'))
const controller = workflow.jobs.controller
const guard = controller.steps[0]
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const verify = new AsyncFunction('github', 'context', guard.with.script)
const context = { repo: { owner: 'example', repo: 'private-controller' }, payload: { inputs: { source_repository: 'other/source' } } }

test('private visibility gates the personal runner and all source preparation without inheriting private environment', () => {
  assert.equal(controller['runs-on'], 'ubuntu-latest')
  assert.equal(controller.if, undefined)
  assert.equal(controller['continue-on-error'], undefined)
  assert.equal(controller.steps.length, 1)
  assert.equal(guard.uses, 'actions/github-script@v7')
  assert.equal(guard.if, undefined)
  assert.equal(guard['continue-on-error'], undefined)
  assert.equal(guard.with['github-token'], '${{ github.token }}')
  assert.equal(workflow.env, undefined)
  assert.equal(controller.env, undefined)
  assert.equal(guard.env, undefined)
  assert.equal(workflow.jobs.acceptance.needs, 'controller')
  assert.equal(workflow.jobs.acceptance.if, undefined)
  assert.equal(workflow.jobs.acceptance['continue-on-error'], undefined)
  assert.ok(workflow.jobs.acceptance.steps.some(step => step.uses === 'actions/checkout@v4'))
})

test('the actual guard admits a private controller using its authoritative repository metadata', async () => {
  const calls = []
  await verify({ rest: { repos: { get: async repository => {
    calls.push(repository)
    return { data: { private: true, visibility: 'private' } }
  } } } }, context)
  assert.deepEqual(calls, [context.repo])
})

for (const [name, metadata] of [
  ['public', { private: false, visibility: 'public' }],
  ['internal', { private: true, visibility: 'internal' }],
  ['unverified', {}],
]) {
  test(`the actual guard fails explicitly for ${name} visibility`, async () => {
    await assert.rejects(verify({ rest: { repos: { get: async () => ({ data: metadata }) } } }, context), /requires a private controller repository/)
  })
}

test('metadata lookup failure blocks work with an explicit verification error', async () => {
  await assert.rejects(verify({ rest: { repos: { get: async () => { throw Object.assign(new Error('Repository metadata unavailable'), { status: 403 }) } } } }, context), /Could not verify controller repository visibility \(HTTP 403\); acceptance has not started/)
})

test('GUI readiness fails fast after dependency installation and before the application build', () => {
  const steps = workflow.jobs.acceptance.steps
  const index = steps.findIndex(step => step.id === 'gui')
  const probe = steps[index]
  assert(index > steps.findIndex(step => step.id === 'install'))
  assert(index < steps.findIndex(step => step.id === 'build'))
  assert.equal(probe.if, undefined)
  assert.equal(probe['continue-on-error'], undefined)
  assert.equal(probe.run, 'node scripts/acceptance/cli.mjs doctor --level gui --json --output tests/acceptance/output/ci/host-readiness-install')
  assert.equal(steps.find(step => step.id === 'install').run, 'node scripts/acceptance/ci-prepare.mjs install')
  const artifacts = steps.find(step => step.name === 'Preserve acceptance report and evidence')
  assert.match(artifacts.if, /always\(\)/)
  assert.equal(artifacts.with.path, '${{ steps.archive.outputs.snapshot-directory }}')
})

const sourceStep = workflow.jobs.acceptance.steps.find(step => step.id === 'source')
const resolve = new AsyncFunction('github', 'core', 'process', sourceStep.with.script)

async function resolveBranch(environment, branches = { 'release_v3.2': 'a'.repeat(40), 'feat/topic': 'b'.repeat(40) }) {
  const outputs = {}
  const calls = []
  const github = { rest: { repos: {
    getBranch: async ({ owner, repo, branch }) => {
      calls.push({ owner, repo, branch })
      if (!branches[branch]) throw Object.assign(new Error('Not Found'), { status: 404 })
      return { data: { commit: { sha: branches[branch] } } }
    },
    getContent: async () => ({}),
  } } }
  await resolve(github, { setOutput: (name, value) => { outputs[name] = value } }, { env: { HALO_SOURCE_REPOSITORY: 'example/source', HALO_CONFIGURED_SOURCE: 'example/source', ...environment } })
  return { outputs, calls }
}

test('any branch of the configured source repository can be tested unless the controller narrows the choice', async () => {
  assert.deepEqual((await resolveBranch({ HALO_SOURCE_REF: 'feat/topic' })).outputs, { revision: 'b'.repeat(40) })
  assert.deepEqual((await resolveBranch({ HALO_SOURCE_REF: 'release_v3.2', HALO_ALLOWED_SOURCE_BRANCHES: '' })).outputs, { revision: 'a'.repeat(40) })
  assert.deepEqual((await resolveBranch({ HALO_SOURCE_REF: 'feat/topic', HALO_ALLOWED_SOURCE_BRANCHES: '["feat/topic"]' })).outputs, { revision: 'b'.repeat(40) })
  await assert.rejects(resolveBranch({ HALO_SOURCE_REF: 'feat/topic', HALO_ALLOWED_SOURCE_BRANCHES: '["release_v3.2"]' }), /not been authorized/)
})

test('another repository, an unknown branch and an unsupported branch name never reach a checkout', async () => {
  await assert.rejects(resolveBranch({ HALO_SOURCE_REF: 'release_v3.2', HALO_SOURCE_REPOSITORY: 'other/source' }), /only executes its configured source repository/)
  await assert.rejects(resolveBranch({ HALO_SOURCE_REF: 'missing' }), /Not Found/)
  for (const ref of ['', '-flag', 'a b', 'x;y', '$(id)', 'a\nb']) {
    const attempt = await resolveBranch({ HALO_SOURCE_REF: ref }).then(() => 'resolved', error => error.message)
    assert.match(attempt, /not supported/, JSON.stringify(ref))
  }
})

test('the findings are published as a small artifact apart from the heavy evidence, even when the heavy upload fails', () => {
  const steps = workflow.jobs.acceptance.steps
  const quality = steps.find(step => step.name === 'Publish the quality summary')
  const evidenceIndex = steps.findIndex(step => step.name === 'Preserve acceptance report and evidence')
  assert(steps.indexOf(quality) < evidenceIndex && steps.indexOf(quality) > steps.findIndex(step => step.id === 'archive'))
  assert.equal(quality.uses, 'actions/upload-artifact@v4')
  assert.equal(quality['continue-on-error'], true)
  assert.equal(quality.with.name, 'quality-${{ github.run_id }}-${{ github.run_attempt }}')
  assert.deepEqual(quality.with.path.trim().split('\n').map(line => line.trim()), ['${{ steps.archive.outputs.snapshot-directory }}/ci/quality.json', '${{ steps.archive.outputs.snapshot-directory }}/ci/summary.md'])
})

test('the baseline comes from the first lineage that has one and reaches both the plan and the finalizer', () => {
  const steps = workflow.jobs.acceptance.steps
  const restore = steps.find(step => step.id === 'restore')
  assert.equal(restore.with.name, '${{ steps.baseline.outputs.artifact-name }}')
  for (const id of ['execute', 'finalize']) assert.equal(steps.find(step => step.id === id).env.HALO_ACCEPTANCE_BASELINE, '${{ runner.temp }}/acceptance-baseline-${{ github.run_id }}/baseline.json')
  assert.equal(workflow.jobs.acceptance.env.HALO_DEFAULT_SOURCE_REF, "${{ vars.HALO_SOURCE_REF || 'main' }}")
  assert.equal(steps.find(step => step.name === 'Publish successful baseline').with.name, '${{ steps.context.outputs.artifact-name }}')
})

test('local archival runs after the summary even when preparation fails, without preventing the independent upload attempt', () => {
  const steps = workflow.jobs.acceptance.steps
  const summaryIndex = steps.findIndex(step => step.id === 'finalize')
  const archiveIndex = steps.findIndex(step => step.id === 'archive')
  const uploadIndex = steps.findIndex(step => step.name === 'Preserve acceptance report and evidence')
  assert(summaryIndex >= 0 && archiveIndex > summaryIndex && uploadIndex > archiveIndex)
  const archive = steps[archiveIndex], upload = steps[uploadIndex]
  assert.equal(archive.if, "always() && steps.initial.outcome == 'success'")
  assert.equal(archive['continue-on-error'], undefined)
  assert.equal(archive.env.HALO_ACCEPTANCE_ARCHIVE_ROOT, '${{ vars.HALO_ACCEPTANCE_ARCHIVE_ROOT }}')
  assert.equal(archive.run, 'exec node scripts/acceptance/ci-archive.mjs')
  assert.equal(upload.if, "always() && steps.archive.outputs.snapshot-directory != ''")
  assert.equal(upload.uses, 'actions/upload-artifact@v4')
  assert.equal(steps.find(step => step.name === 'Publish successful baseline').if, "success() && steps.execute.outcome == 'success' && steps.finalize.outputs.final == 'true' && steps.archive.outputs.source-final == 'true' && steps.finalize.outputs.baseline-file != ''")
})

test('the CI owner receives signals directly and finalization precedes immutable-snapshot upload', () => {
  const steps = workflow.jobs.acceptance.steps
  assert.equal(steps.find(step => step.id === 'execute').run, 'exec node scripts/acceptance/ci-run.mjs')
  assert.equal(steps.find(step => step.id === 'finalize').run, 'exec node scripts/acceptance/ci-finalize.mjs')
  assert.equal(steps.find(step => step.name === 'Publish successful baseline').with.path, '${{ steps.finalize.outputs.baseline-file }}')
})
