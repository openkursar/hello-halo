import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const finalizer = fileURLToPath(new URL('../../../../scripts/acceptance/ci-finalize.mjs', import.meta.url))
export const source = fileURLToPath(new URL('../../../../scripts/acceptance/ci-run.mjs', import.meta.url))
export const scenario = requirements => ({ caseId: 'example.journey', variant: { client: 'desktop' }, requirements, testIds: ['bound-test'] })
export const binding = { caseId: 'example.journey', variant: { client: 'desktop' }, evidence: 'app-e2e', mode: 'none' }
export const selection = requirements => ({ cases: [scenario(requirements)], tests: [{ id: 'bound-test', bindings: [binding] }] })

export function fixture(context, options = {}) {
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
import fs from 'node:fs'; import path from 'node:path'; import { spawn } from 'node:child_process';
const args=process.argv.slice(2), command=args[0];
const configuration=JSON.parse(fs.readFileSync('fixture.json','utf8'));
const context=JSON.parse(fs.readFileSync('tests/acceptance/output/ci/context.json','utf8'));
const record=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
const output=()=>args[args.indexOf('--output')+1];
fs.appendFileSync('tests/acceptance/output/ci/invocations.jsonl',JSON.stringify({command,args,packaged:process.env.HALO_E2E_PACKAGED_APP??null,browserCache:process.env.PLAYWRIGHT_BROWSERS_PATH??null})+'\\n');
if(configuration.orphanCommand===command) {
  const marker='tests/acceptance/output/ci/orphan-ready.json';
  const program="require('node:fs').writeFileSync("+JSON.stringify(marker)+",JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);";
  const child=spawn(process.execPath,['-e',program],{stdio:'ignore'});
  child.unref();
  const ready=setInterval(()=>{if(fs.existsSync(marker)){clearInterval(ready);process.exit(0)}},10);
  await new Promise(()=>{});
}
if(configuration.hangCommand===command) {
  record('tests/acceptance/output/ci/stage-ready.json',{pid:process.pid});
  const writer=setInterval(()=>fs.appendFileSync('tests/acceptance/output/ci/active-writer.log','owned writer\\n'),20);
  if(configuration.cooperativeExit) for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{clearInterval(writer);record('tests/acceptance/output/ci/stage-exit.json',{code:0,signal});process.exit(0)});
  await new Promise(()=>{});
}
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
      record('out/.acceptance-package.json',{version:configuration.packageRecord==='legacy'?1:2,id:'new-package',platform:context.platform,architecture:context.architecture,build:{id:configuration.packageRecord==='wrong-build'?'old-build':'current-controlled-build'},directory,executable:configuration.packageRecord==='external'?path.resolve('..','external-application'):executable});
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
  const environment = () => ({ ...process.env, GITHUB_REPOSITORY: 'example/controller', GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', HALO_E2E_PACKAGED_APP: path.join(root, 'unrelated-old-package'), PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'unrelated-browser-data'), HALO_ACCEPTANCE_BASELINE: '', HALO_ACCEPTANCE_FULL: 'true' })
  const finalize = outcome => spawnSync(process.execPath, [finalizer], { cwd: root, encoding: 'utf8', env: { ...environment(), HALO_CI_STAGE_OUTCOMES: JSON.stringify({ execute: { outcome } }) }, timeout: 20000 })
  return { root, directory: path.join(root, 'tests/acceptance/output/ci'), environment, finalize, start() {
    return spawn(process.execPath, [source], { cwd: root, env: environment(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
  }, run() {
    const env = environment()
    const result = spawnSync(process.execPath, [source], { cwd: root, encoding: 'utf8', env, timeout: 20000 })
    const finalization = finalize(result.status === 0 ? 'success' : 'failure')
    return { ...result, status: result.status || finalization.status, stderr: result.stderr + finalization.stderr, finalization }

  } }
}

export function evidence(fixture) {
  return {
    stages: JSON.parse(fs.readFileSync(path.join(fixture.directory, 'stages.json'), 'utf8')),
    calls: fs.readFileSync(path.join(fixture.directory, 'invocations.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)),
    baseline: fs.existsSync(path.join(fixture.root, 'tests/acceptance/output/ci-baseline/baseline.json')),
  }
}
