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

test('GUI readiness fails fast after public installation and before SDK preparation or application build', () => {
  const steps = workflow.jobs.acceptance.steps
  const index = steps.findIndex(step => step.id === 'gui')
  const probe = steps[index]
  assert(index > steps.findIndex(step => step.id === 'install'))
  assert(index < steps.findIndex(step => step.name === 'Check out optional SDK'))
  assert(index < steps.findIndex(step => step.id === 'build'))
  assert.equal(probe.if, undefined)
  assert.equal(probe['continue-on-error'], undefined)
  assert.equal(probe.run, 'node scripts/acceptance/cli.mjs doctor --level gui --json --output tests/acceptance/output/ci/host-readiness-install')
  assert.equal(steps.find(step => step.id === 'install').run, 'node scripts/acceptance/ci-prepare.mjs install')
  const artifacts = steps.find(step => step.name === 'Preserve acceptance report and evidence')
  assert.match(artifacts.if, /always\(\)/)
  assert.equal(artifacts.with.path, 'halo/tests/acceptance/output/ci/')
})

test('local archival runs after the summary even when preparation fails, without preventing the independent upload attempt', () => {
  const steps = workflow.jobs.acceptance.steps
  const summaryIndex = steps.findIndex(step => step.name === 'Write job summary')
  const archiveIndex = steps.findIndex(step => step.id === 'archive')
  const uploadIndex = steps.findIndex(step => step.name === 'Preserve acceptance report and evidence')
  assert(summaryIndex >= 0 && archiveIndex > summaryIndex && uploadIndex > archiveIndex)
  const archive = steps[archiveIndex], upload = steps[uploadIndex]
  assert.equal(archive.if, "always() && steps.initial.outcome == 'success'")
  assert.equal(archive['continue-on-error'], undefined)
  assert.equal(archive.env.HALO_ACCEPTANCE_ARCHIVE_ROOT, '${{ vars.HALO_ACCEPTANCE_ARCHIVE_ROOT }}')
  assert.equal(archive.run, 'node scripts/acceptance/ci-archive.mjs')
  assert.equal(upload.if, "always() && steps.initial.outcome == 'success'")
  assert.equal(upload.uses, 'actions/upload-artifact@v4')
  assert.equal(steps.find(step => step.name === 'Publish successful baseline').if, "success() && steps.execute.outcome == 'success'")
})
