import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts/acceptance/ci-run.mjs')
const scenario = requirements => ({ caseId: 'example.journey', variant: { client: 'desktop' }, requirements, testIds: ['bound-test'] })
const binding = { caseId: 'example.journey', variant: { client: 'desktop' }, evidence: 'app-e2e', mode: 'none' }
const selection = requirements => ({ cases: [scenario(requirements)], tests: [{ id: 'bound-test', bindings: [binding] }] })

function fixture(context, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-ci-run-')))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const write = (name, value) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)) }
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Acceptance test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Acceptance test', GIT_COMMITTER_EMAIL: 'test@example.invalid' }, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  git(['init', '--quiet'])
  const tree = git(['write-tree'])
  const revision = git(['commit-tree', tree, '-m', 'Isolated CI fixture'])
  git(['update-ref', 'HEAD', revision])
  write('tests/acceptance/output/ci/context.json', { version: 1, repository: 'example/application', ref: 'main', revision, dirty: false, profile: 'fast', platform: process.platform, architecture: process.arch, sdk: { state: 'absent' } })
  write('out/.acceptance-build.json', { version: 2, id: 'current-controlled-build' })
  write('out/.acceptance-package.json', { version: 1, id: 'previous-package', executable: 'old/application' })
  write('fixture.json', { plan: selection(['packaged-app']), ...options })
  write('scripts/acceptance/cli.mjs', `
import fs from 'node:fs'; import path from 'node:path';
const args=process.argv.slice(2), command=args[0];
const configuration=JSON.parse(fs.readFileSync('fixture.json','utf8'));
const context=JSON.parse(fs.readFileSync('tests/acceptance/output/ci/context.json','utf8'));
const record=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
const output=()=>args[args.indexOf('--output')+1];
fs.appendFileSync('tests/acceptance/output/ci/invocations.jsonl',JSON.stringify({command,args,packaged:process.env.HALO_E2E_PACKAGED_APP??null,browserCache:process.env.PLAYWRIGHT_BROWSERS_PATH??null})+'\\n');
if(command==='doctor' && args[args.indexOf('--level')+1]==='gui') {
  if(configuration.guiRecord!=='absent') record(output()+'/readiness.json',{version:1,kind:'host-gui-readiness',ready:!configuration.guiFailure,observations:{electronConnected:true,appReady:true,windowCreated:true,clickConfirmed:configuration.guiRecord!=='unclicked'},cleanup:{complete:configuration.guiRecord!=='unclean'},failure:configuration.guiFailure?{stage:'app-ready',message:'No graphical session'}:undefined});
  if(configuration.guiFailure) process.exit(2);
}
if(command==='discover') record(output(),{version:1,tests:configuration.plan.tests});
if(command==='plan') record(output(),configuration.plan);
if(command==='package') {
  if(configuration.packageFailure) process.exit(7);
  if(configuration.packageRecord!=='unchanged') {
    fs.rmSync('out/.acceptance-package.json',{force:true});
    if(configuration.packageRecord!=='absent') {
      const directory='tests/acceptance/output/packaged/application';
      const executable=directory+'/application';
      record(executable,{application:'fresh'});
      record('out/.acceptance-package.json',{version:1,id:'new-package',platform:context.platform,architecture:context.architecture,build:{id:configuration.packageRecord==='wrong-build'?'old-build':'current-controlled-build'},directory,executable:configuration.packageRecord==='external'?path.resolve('..','external-application'):executable});
    }
  }
}
if(command==='run') {
  const failed=Boolean(configuration.runFailure);
  record(output()+'/run.json',{version:1,id:'run',finishedAt:new Date().toISOString(),revision:{commit:context.revision,dirty:false,worktreeHash:'fixture'},profile:context.profile,platform:context.platform,catalogHash:'catalog',manifestHash:'manifest',status:failed?'incomplete':'passed',selectedCount:configuration.plan.cases.length,cases:configuration.plan.cases.map(item=>({caseId:item.caseId,variant:item.variant,status:failed?'blocked':'passed'})),summary:failed?{blocked:configuration.plan.cases.length}:{passed:configuration.plan.cases.length},evidenceIntegrity:{version:1,valid:true,reasons:[]}});
  if(failed) process.exit(2);
}
if(command==='report') record(output()+'/generated.json',{generated:true});
`)
  write('scripts/acceptance/ci-prepare.mjs', `
import fs from 'node:fs';
const configuration=JSON.parse(fs.readFileSync('fixture.json','utf8'));
fs.appendFileSync('tests/acceptance/output/ci/invocations.jsonl',JSON.stringify({command:'browser',args:process.argv.slice(2),packaged:process.env.HALO_E2E_PACKAGED_APP??null,browserCache:process.env.PLAYWRIGHT_BROWSERS_PATH??null})+'\\n');
if(configuration.browserFailure)process.exit(12);
`)
  return { root, directory: path.join(root, 'tests/acceptance/output/ci'), run() {
    return spawnSync(process.execPath, [source], { cwd: root, encoding: 'utf8', env: { ...process.env, HALO_E2E_PACKAGED_APP: path.join(root, 'unrelated-old-package'), PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'unrelated-browser-data'), HALO_ACCEPTANCE_BASELINE: '', HALO_ACCEPTANCE_FULL: 'true' }, timeout: 20000 })
  } }
}

function evidence(fixture) {
  return {
    stages: JSON.parse(fs.readFileSync(path.join(fixture.directory, 'stages.json'), 'utf8')),
    calls: fs.readFileSync(path.join(fixture.directory, 'invocations.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)),
    baseline: fs.existsSync(path.join(fixture.directory, 'baseline.json')),
  }
}

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
