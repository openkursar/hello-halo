import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fixture, evidence, scenario, binding, selection } from './fixtures/ci-application.mjs'

test('a selected executable packaged journey builds a fresh package and passes only its recorded executable to the standard run', context => {
  const selected = fixture(context)
  const result = selected.run()
  assert.equal(result.status, 0, result.stderr)
  const { calls, stages, baseline } = evidence(selected)
  assert.deepEqual(calls.map(call => call.command), ['validate', 'doctor', 'discover', 'plan', 'package', 'doctor', 'run', 'report'])
  assert(calls.filter(call => call.command !== 'run').every(call => call.packaged === null))
  const run = calls.find(call => call.command === 'run')
  assert.equal(run.packaged, path.join(selected.root, 'tests/acceptance/output/packaged/application/application'))
  assert(run.args.includes('--plan'))
  assert.equal(calls.find(call => call.command === 'package').args.at(-1), '1800000')
  assert.equal(stages.find(stage => stage.stage === 'package preparation').exitCode, 0)
  assert.equal(baseline, true)
})

test('a selection without packaged requirements neither builds nor inherits an arbitrary existing application', context => {
  const selected = fixture(context, { plan: selection([]) })
  const result = selected.run()
  assert.equal(result.status, 0, result.stderr)
  const { calls, stages } = evidence(selected)
  assert.equal(calls.some(call => call.command === 'package'), false)
  assert.equal(calls.some(call => call.command === 'browser'), false)
  assert(calls.every(call => call.packaged === null))
  assert.equal(stages.some(stage => stage.stage === 'package preparation'), false)
})

test('selected Chromium requirements prepare the browser before the normal run with the same isolated cache policy', context => {
  const selected = fixture(context, { plan: selection(['chromium-browser']) })
  const result = selected.run()
  assert.equal(result.status, 0, result.stderr)
  const { calls, stages, baseline } = evidence(selected)
  assert.deepEqual(calls.map(call => call.command), ['validate', 'doctor', 'discover', 'plan', 'browser', 'doctor', 'run', 'report'])
  assert(calls.every(call => call.browserCache === null))
  assert.equal(stages.find(stage => stage.stage === 'browser preparation').exitCode, 0)
  assert.equal(baseline, true)
})

test('blocked or unbound Chromium cases do not prepare a browser', context => {
  for (const entry of [{ ...scenario(['chromium-browser']), blockedReason: 'Unsupported condition' }, { ...scenario(['chromium-browser']), testIds: [] }]) {
    const selected = fixture(context, { plan: { ...selection(['chromium-browser']), cases: [entry] }, runFailure: true })
    assert.equal(selected.run().status, 1)
    assert.equal(evidence(selected).calls.some(call => call.command === 'browser'), false)
  }
})

test('browser preparation failure records the failed stage before any package, test or baseline is produced', context => {
  const selected = fixture(context, { plan: selection(['chromium-browser', 'packaged-app']), browserFailure: true })
  assert.equal(selected.run().status, 1)
  const { calls, stages, baseline } = evidence(selected)
  assert.equal(calls.some(call => call.command === 'package' || call.command === 'run'), false)
  assert.equal(stages.at(-1).stage, 'browser preparation')
  assert.equal(stages.at(-1).exitCode, 12)
  assert.equal(baseline, false)
})

test('blocked, unbound and mismatched-variant cases cannot trigger packaging', context => {
  for (const plan of [
    { ...selection(['packaged-app']), cases: [{ ...scenario(['packaged-app']), blockedReason: 'Human verification is required' }] },
    { ...selection(['packaged-app']), cases: [{ ...scenario(['packaged-app']), testIds: [] }] },
    { cases: [scenario(['packaged-app'])], tests: [{ id: 'bound-test', bindings: [{ ...binding, variant: { client: 'other' } }] }] },
  ]) {
    const selected = fixture(context, { plan, runFailure: true })
    assert.equal(selected.run().status, 1)
    const { calls, baseline } = evidence(selected)
    assert.equal(calls.some(call => call.command === 'package'), false)
    assert.equal(calls.find(call => call.command === 'run').packaged, null)
    assert.equal(calls.at(-1).command, 'report')
    assert.equal(baseline, false)
  }
})

test('packaging failure records the failed stage without running tests or publishing a previous baseline', context => {
  const selected = fixture(context, { packageFailure: true })
  const result = selected.run()
  assert.equal(result.status, 1)
  const { calls, stages, baseline } = evidence(selected)
  assert.equal(calls.some(call => call.command === 'run'), false)
  assert.equal(stages.at(-1).stage, 'package preparation')
  assert.equal(stages.at(-1).exitCode, 7)
  assert.equal(baseline, false)
  assert.equal(fs.existsSync(path.join(selected.directory, 'plan.json')), true)
})

test('a zero-exit stage with a real orphan retains raw zero while validation fails', { skip: process.platform === 'win32', timeout: 15000 }, context => {
  const selected = fixture(context, { orphanCommand: 'package' })
  const result = selected.run()
  assert.equal(result.status, 1, result.stderr)
  const { calls, stages, baseline } = evidence(selected)
  const stage = stages.at(-1)
  assert.equal(stage.stage, 'package preparation')
  assert.equal(stage.processExitCode, 0)
  assert.equal(stage.exitCode, 1)
  assert.equal(stage.status, 'failed')
  assert.equal(stage.cleanupConfirmed, true)
  assert.equal(calls.some(call => call.command === 'run'), false)
  assert.equal(baseline, false)
  const child = JSON.parse(fs.readFileSync(path.join(selected.directory, 'orphan-ready.json'), 'utf8'))
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' })
  const completion = JSON.parse(fs.readFileSync(path.join(selected.directory, 'producer-completion.json'), 'utf8'))
  assert.equal(completion.owner.outcome, 'failed')
  assert(completion.producers.every(producer => producer.exitCode === 0 && producer.cleanupConfirmed))
})

test('a successful package command still fails its stage if its recorded output is absent, stale, from another build or outside the checkout', context => {
  for (const packageRecord of ['absent', 'unchanged', 'wrong-build', 'external']) {
    const selected = fixture(context, { packageRecord })
    const result = selected.run()
    assert.equal(result.status, 1)
    const { calls, stages, baseline } = evidence(selected)
    assert.equal(calls.some(call => call.command === 'run'), false)
    assert.equal(stages.at(-1).stage, 'package preparation')
    assert.equal(stages.at(-1).exitCode, 1)
    assert(stages.at(-1).error)
    assert.equal(baseline, false)
  }
})

test('a newly written version 1 package cannot run tests or advance the baseline without runtime provenance', context => {
  const selected = fixture(context, { packageRecord: 'legacy' })
  assert.equal(selected.run().status, 1)
  const { calls, stages, baseline } = evidence(selected)
  assert.equal(calls.some(call => call.command === 'run'), false)
  assert.equal(stages.at(-1).stage, 'package preparation')
  assert.match(stages.at(-1).error, /current Electron runtime identity/)
  assert.equal(baseline, false)
})

test('host GUI readiness is a distinct bounded prerequisite before execution and is not a product case', context => {
  const selected = fixture(context, { plan: selection([]) })
  const result = selected.run()
  assert.equal(result.status, 0, result.stderr)
  const { calls, stages, baseline } = evidence(selected)
  const probe = calls.find(call => call.command === 'doctor' && call.args.includes('gui'))
  assert(probe)
  assert.equal(probe.args[probe.args.indexOf('--output') + 1], path.join(selected.directory, 'host-readiness-execution'))
  assert.equal(calls[calls.indexOf(probe) + 1].command, 'run')
  assert.equal(stages.find(stage => stage.stage === 'host readiness').exitCode, 0)
  assert.equal(JSON.parse(fs.readFileSync(path.join(selected.directory, 'run/run.json'), 'utf8')).selectedCount, 1)
  assert.equal(baseline, true)
})

test('unavailable GUI or an absent, unclicked or unclean probe result blocks product execution and baseline publication', context => {
  for (const options of [{ guiFailure: true }, { guiRecord: 'absent' }, { guiRecord: 'unclicked' }, { guiRecord: 'unclean' }]) {
    const selected = fixture(context, { plan: selection([]), ...options })
    assert.equal(selected.run().status, 1)
    const { calls, stages, baseline } = evidence(selected)
    assert.equal(stages.at(-1).stage, 'host readiness')
    assert.equal(stages.at(-1).exitCode, options.guiFailure ? 2 : 1)
    assert.equal(calls.some(call => call.command === 'run' || call.command === 'report'), false)
    assert.equal(fs.existsSync(path.join(selected.directory, 'run/run.json')), false)
    assert.equal(baseline, false)
  }
})

test('a previous host probe cannot be reused as current GUI readiness evidence', context => {
  const selected = fixture(context, { plan: selection([]) })
  fs.mkdirSync(path.join(selected.directory, 'host-readiness-execution'))
  const result = selected.run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /already contains host-readiness evidence/)
  assert.equal(evidence(selected).calls.some(call => call.command === 'run'), false)
  assert.equal(evidence(selected).baseline, false)
})
