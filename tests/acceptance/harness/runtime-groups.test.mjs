import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { executionGroups } from '../../../scripts/acceptance/lib/execution.mjs'
import { makePlan } from '../../../scripts/acceptance/lib/planner.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const revision = { commit: 'a'.repeat(40), dirty: false, worktreeHash: 'b'.repeat(64) }
const binding = (caseId, variant = {}) => ({ caseId, variant, mode: 'none', evidence: 'app-e2e' })
const scenario = (id, requirements = [], changes = {}) => ({ id, storyId: 'checks.story', module: 'checks', title: id, basis: 'documented', profiles: ['regression'], platforms: [process.platform], variants: {}, evidence: 'app-e2e', mode: 'none', automation: 'automated', requirements, verifies: ['works'], ...changes })
const declaredTest = (id, changes = {}) => ({ id, executor: 'playwright', title: id, titlePath: ['Deliberately identical project', id], file: `tests/e2e/${id}.spec.ts`, project: 'same-project', bindings: [binding(`checks.${id}`)], ...changes })

test('runtime classification uses eligible selected bindings and exact variants, never project names', () => {
  const tests = [declaredTest('shared', { project: 'misleading-packaged-project', bindings: [binding('checks.source', { view: 'desktop' }), binding('checks.package', { view: 'desktop' })] })]
  const source = { caseId: 'checks.source', variant: { view: 'desktop' }, testIds: ['shared'], requirements: [] }
  const packaged = { caseId: 'checks.package', variant: { view: 'desktop' }, testIds: ['shared'], requirements: ['packaged-app'] }
  assert.equal(executionGroups(tests, [source])[0].host, 'source')
  assert.equal(executionGroups(tests, [source, { ...packaged, blockedReason: 'Unavailable' }])[0].host, 'source')
  assert.equal(executionGroups(tests, [source, { ...packaged, variant: { view: 'mobile' } }])[0].host, 'source')
  assert.equal(executionGroups(tests, [source, packaged])[0].host, 'packaged')
  assert.throws(() => executionGroups(tests, [{ ...packaged, blockedReason: 'Unavailable' }]), /no eligible selected binding/)
  assert.throws(() => executionGroups([{ ...tests[0], executor: 'cluster' }], [packaged]), /cannot fulfill a packaged-app/)
})

async function workspace(context, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-runtime-groups-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const write = async (file, value) => { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value)) }
  const original = process.env.HALO_E2E_PACKAGED_APP
  const originalMail = process.env.HALO_ACCEPTANCE_TEST_MAIL_ACCOUNT
  delete process.env.HALO_ACCEPTANCE_TEST_MAIL_ACCOUNT
  const inherited = path.join(root, 'stale-application')
  await write('stale-application', 'A path must not choose the test host by itself')
  await write('controlled/application', 'Controlled synthetic application')
  process.env.HALO_E2E_PACKAGED_APP = inherited
  context.after(() => { if (original === undefined) delete process.env.HALO_E2E_PACKAGED_APP; else process.env.HALO_E2E_PACKAGED_APP = original })
  context.after(() => { if (originalMail === undefined) delete process.env.HALO_ACCEPTANCE_TEST_MAIL_ACCOUNT; else process.env.HALO_ACCEPTANCE_TEST_MAIL_ACCOUNT = originalMail })
  const cases = [scenario('checks.source'), scenario('checks.packaged', ['packaged-app']), scenario('checks.cluster'), scenario('checks.unbound', [], { automation: 'planned' }), scenario('checks.blocked', ['test-mail-account'])]
  const tests = [declaredTest('source'), declaredTest('packaged'), declaredTest('cluster', { executor: 'cluster' }), declaredTest('blocked')]
  if (options.sharedBinding) tests.splice(0, 2, declaredTest('shared', { bindings: [binding('checks.source'), binding('checks.packaged')] }))
  if (options.blockPackage) cases[1].requirements.push('test-mail-account')
  const selectedCases = options.sourceOnly ? [cases[0], cases[3]] : cases
  const selectedTests = options.sourceOnly ? [tests[0]] : [...tests.filter(test => test.executor === 'playwright'), ...tests.filter(test => test.executor === 'cluster')]
  const catalog = { hash: 'c'.repeat(64), modules: [{ id: 'checks', paths: ['src/**'], dependsOn: [] }], cases: selectedCases, approvals: [] }
  const manifest = { version: 1, catalogHash: catalog.hash, revision, tests: selectedTests }
  const plan = makePlan(catalog, manifest, { profile: 'regression', platform: process.platform, revision })
  await write('fixture.json', { tests: selectedTests, ...options })
  await write('node_modules/@playwright/test/cli.js', `import('../../../fixture-worker.mjs')`)
  await write('node_modules/@playwright/test/package.json', { type: 'module' })
  for (const name of ['yaml', 'zod']) await fs.symlink(path.join(repository, 'node_modules', name), path.join(root, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir')
  await write('fixture-worker.mjs', `
import fs from 'node:fs';
const args=process.argv.slice(2), configuration=JSON.parse(fs.readFileSync('fixture.json','utf8'));
const discovery=args.includes('--list'), cluster=args[0]==='cluster';
const selected=discovery?configuration.tests.filter(test=>test.executor==='playwright'):JSON.parse(fs.readFileSync(cluster?args[1]:process.env.HALO_ACCEPTANCE_SELECTION_FILE,'utf8'));
const output=process.env.HALO_ACCEPTANCE_REPORT;
const emit=value=>fs.appendFileSync(output,JSON.stringify(value)+'\\n');
fs.appendFileSync('observed.jsonl',JSON.stringify({discovery,cluster,ids:selected.map(test=>test.id),packaged:process.env.HALO_E2E_PACKAGED_APP??null,pid:process.pid})+'\\n');
emit({type:'begin',tests:selected});
if(!discovery){
 if(configuration.hangSource && selected.some(test=>test.id==='source'))await new Promise(()=>setInterval(()=>{},1000));
 const failed=selected.some(test=>test.id===configuration.failTest);
 for(const test of selected){
  const id=configuration.crossBatch && test.id==='source'?'packaged':test.id;
  const declared=configuration.tests.find(test=>test.id===id);
  emit({type:'test',id,bindings:declared.bindings,status:test.id===configuration.failTest?'failed':'passed',retry:0,duration:1,startedAt:new Date().toISOString(),attachments:[],errors:[],executionHost:{kind:'untrusted-child-value'}});
 }
 if(!configuration.missingEnd)emit({type:'end',status:failed?'failed':'passed'});
 if(failed)process.exitCode=1;
}else emit({type:'end',status:'passed'});
`)
  const packageStub = `
import fs from 'node:fs/promises';
export async function verifyPackagedApplication(root, executable){
 const configuration=JSON.parse(await fs.readFile(root+'/fixture.json','utf8'));
 await fs.appendFile(root+'/package-checks.jsonl',JSON.stringify({called:true})+'\\n');
 if(configuration.packageFailure)throw new Error('The controlled package changed');
 return {id:'controlled-package',packagedAt:'2026-01-01T00:00:00Z',content:{rootSha256:'package-hash'},executable:'controlled/application',coverage:'synthetic-runtime-test'};
}`
  const clusterStub = `
import fs from 'node:fs/promises';import path from 'node:path';
import {execute} from ${JSON.stringify(path.join(repository, 'scripts/acceptance/lib/process.mjs'))};
import {clusterEnvironment} from ${JSON.stringify(path.join(repository, 'scripts/acceptance/adapters/cluster.mjs'))};
export async function discoverClusterTests(root){return JSON.parse(await fs.readFile(root+'/fixture.json','utf8')).tests.filter(test=>test.executor==='cluster')}
export async function executeClusterTests(root,tests,{outputDirectory,eventFile,environment,timeoutMs}){
 const selected=path.join(outputDirectory,'cluster-selection.json');await fs.writeFile(selected,JSON.stringify(tests));
 const child=await clusterEnvironment(root,'none',environment);
 return execute(root,['fixture-worker.mjs','cluster',selected],{environment:{...child,HALO_ACCEPTANCE_REPORT:eventFile},timeoutMs});
}`
  const processStub = `
import fs from 'node:fs/promises';
import {execute as realExecute,redact} from ${JSON.stringify(path.join(repository, 'scripts/acceptance/lib/process.mjs'))};
export {redact};
export async function execute(root,args,options){
 const result=await realExecute(root,args,options);
 const configuration=JSON.parse(await fs.readFile(root+'/fixture.json','utf8'));
 if(!args.includes('--list') && configuration.cleanupFailure && options.environment.HALO_E2E_PACKAGED_APP===undefined)return {...result,code:1,cleanupFailed:true};
 return result;
}`
  const stubs = {
    './source.mjs': `export async function sourceIdentity(){return ${JSON.stringify(revision)}}`,
    './build.mjs': `export async function verifyBuild(){return {id:'controlled-build',builtAt:'2026-01-01T00:00:00Z',inputs:{rootSha256:'inputs'},artifacts:{rootSha256:'artifacts'},sdk:{state:'absent'},platform:process.platform,architecture:process.arch,node:process.versions.node}}`,
    './package.mjs': packageStub,
    './process.mjs': processStub,
    '../adapters/cluster.mjs': clusterStub,
  }
  const compiled = path.join(root, 'execution.mjs')
  await build({ entryPoints: [path.join(repository, 'scripts/acceptance/lib/execution.mjs')], outfile: compiled, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent', plugins: [{ name: 'isolated-runtime-facilities', setup(build) {
    build.onResolve({ filter: /^\.\/(source|build|package|process)\.mjs$|^\.\.\/adapters\/cluster\.mjs$/ }, args => args.importer === path.join(repository, 'scripts/acceptance/lib/execution.mjs') ? { path: args.path, namespace: 'runtime-facility' } : undefined)
    build.onLoad({ filter: /.*/, namespace: 'runtime-facility' }, args => ({ contents: stubs[args.path], loader: 'js', resolveDir: repository }))
  } }] })
  const { runPlan } = await import(pathToFileURL(compiled).href)
  return {
    root, plan, catalog,
    run: () => runPlan(root, catalog, plan, path.join(root, 'run'), { timeoutMs: options.hangSource ? 300 : 10000 }),
    observations: async () => (await fs.readFile(path.join(root, 'observed.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
    packageChecks: async () => fs.readFile(path.join(root, 'package-checks.jsonl'), 'utf8').then(value => value.trim().split('\n').length).catch(error => { if (error.code === 'ENOENT') return 0; throw error }),
  }
}

test('mixed plans keep every case while real source and cluster children clear an inherited package path', async context => {
  const selected = await workspace(context)
  const result = await selected.run()
  assert.equal(result.status, 'incomplete')
  assert.equal(result.selectedCount, 5)
  assert.deepEqual(result.cases.map(item => item.status), ['passed', 'passed', 'passed', 'blocked', 'blocked'])
  assert.equal(result.evidenceIntegrity.valid, true)
  const observations = await selected.observations()
  assert.equal(observations.find(item => item.discovery).packaged, null)
  assert.equal(observations.find(item => item.ids.includes('source') && !item.discovery).packaged, null)
  assert.equal(observations.find(item => item.cluster).packaged, null)
  assert.equal(observations.find(item => item.ids.includes('packaged') && !item.discovery).packaged, path.join(selected.root, 'controlled/application'))
  assert.equal(observations.some(item => !item.discovery && item.ids.includes('blocked')), false)
  assert.deepEqual(result.executionBatches.map(batch => batch.executionHost.kind), ['source', 'packaged', 'cluster'])
  for (const entry of result.cases.slice(0, 3)) {
    const attempt = entry.attempts[0]
    const batch = result.executionBatches.find(batch => batch.id === attempt.executionHost.batchId)
    assert.equal(attempt.executionHost.kind, batch.executionHost.kind)
    assert.equal(attempt.executionHost.buildId, 'controlled-build')
    assert.equal(attempt.executionHost.packageId, entry.caseId === 'checks.packaged' ? 'controlled-package' : undefined)
  }
  assert.equal(result.packageIdentity.id, 'controlled-package')
  assert.equal(await selected.packageChecks(), 2)
})

test('an unrelated inherited package is neither validated nor recorded for a source-only selection', async context => {
  const selected = await workspace(context, { sourceOnly: true, packageFailure: true })
  const result = await selected.run()
  assert.equal(result.summary.passed, 1)
  assert.equal(result.packageIdentity, null)
  assert.equal(await selected.packageChecks(), 0)
  assert((await selected.observations()).every(item => item.packaged === null))
})

for (const blockPackage of [false, true]) test(`one executable bound to two cases runs once with the eligible runtime (package blocked=${blockPackage})`, async context => {
  const selected = await workspace(context, { sharedBinding: true, blockPackage })
  const result = await selected.run()
  const source = result.cases.find(item => item.caseId === 'checks.source')
  const packaged = result.cases.find(item => item.caseId === 'checks.packaged')
  assert.equal(source.status, 'passed')
  assert.equal(packaged.status, blockPackage ? 'blocked' : 'passed')
  assert.equal(source.attempts.length, 1)
  assert.equal(packaged.attempts.length, 1)
  assert.equal(source.attempts[0].executionHost.kind, blockPackage ? 'source' : 'packaged')
  assert.deepEqual(packaged.attempts[0].executionHost, source.attempts[0].executionHost)
  const invocations = (await selected.observations()).filter(item => !item.discovery && item.ids.includes('shared'))
  assert.equal(invocations.length, 1)
  assert.equal(invocations[0].packaged, blockPackage ? null : path.join(selected.root, 'controlled/application'))
  assert.equal(result.packageIdentity?.id ?? null, blockPackage ? null : 'controlled-package')
  assert.equal(result.selectedCount, 5)
})

test('a product failure keeps later runtime batches and full blocked coverage visible', async context => {
  const selected = await workspace(context, { failTest: 'source' })
  const result = await selected.run()
  assert.equal(result.status, 'failed')
  assert.equal(result.evidenceIntegrity.valid, true)
  assert.deepEqual(result.cases.map(item => item.status), ['failed', 'passed', 'passed', 'blocked', 'blocked'])
  assert.deepEqual(result.executionBatches.map(batch => batch.status), ['failed', 'completed', 'completed'])
})

test('package verification failure retains earlier attempts without attaching a package that was never supplied', async context => {
  const selected = await workspace(context, { packageFailure: true })
  const result = await selected.run()
  assert.equal(result.status, 'failed')
  assert.equal(result.evidenceIntegrity.valid, false)
  assert.equal(result.packageIdentity, null)
  assert.equal(result.cases[0].attempts[0].status, 'passed')
  assert.equal(result.cases[0].attempts[0].executionHost.kind, 'source')
  assert.equal(result.cases[0].status, 'not-run')
  assert.equal((await selected.observations()).filter(item => !item.discovery).length, 1)
})

test('a test reported from the wrong runtime batch cannot borrow the other batch host', async context => {
  const selected = await workspace(context, { crossBatch: true })
  const result = await selected.run()
  assert.equal(result.evidenceIntegrity.valid, false)
  assert.match(result.errors.join('\n'), /outside its selected runtime batch/)
  const attempts = result.cases.find(item => item.caseId === 'checks.packaged').attempts
  assert.deepEqual(attempts.map(attempt => attempt.executionHost.kind), ['source', 'packaged'])
  assert.equal(result.summary.passed, 0)
})

test('unconfirmed cleanup prevents subsequent runtime batches from starting', async context => {
  const selected = await workspace(context, { cleanupFailure: true })
  const result = await selected.run()
  assert.equal(result.evidenceIntegrity.valid, false)
  assert.match(result.errors.join('\n'), /could not confirm cleanup/)
  assert.deepEqual(result.executionBatches.map(batch => batch.status), ['failed', 'not-run', 'not-run'])
  assert.equal((await selected.observations()).filter(item => !item.discovery).length, 1)
  assert.equal(result.packageIdentity, null)
})

test('the shared timeout kills an owned real child and leaves later runtime cases not run', async context => {
  const selected = await workspace(context, { hangSource: true })
  const result = await selected.run()
  const child = (await selected.observations()).find(item => !item.discovery)
  assert(child)
  assert.throws(() => process.kill(child.pid, 0), error => error.code === 'ESRCH')
  assert.equal(result.runner.timedOut, true)
  assert.equal(result.cases.find(item => item.caseId === 'checks.packaged').status, 'not-run')
  assert.equal(result.cases.find(item => item.caseId === 'checks.cluster').status, 'not-run')
  assert.equal(result.packageIdentity, null)
})

test('a successful process exit without its terminal batch record cannot establish verification', async context => {
  const selected = await workspace(context, { missingEnd: true, sourceOnly: true })
  const result = await selected.run()
  assert.equal(result.status, 'failed')
  assert.equal(result.evidenceIntegrity.valid, false)
  assert.match(result.errors.join('\n'), /without a successful terminal batch record/)
  assert.equal(result.cases[0].attempts[0].status, 'passed')
  assert.equal(result.summary.passed, 0)
})

test('packaged fixtures refuse legacy dist fallback in acceptance mode but preserve ordinary manual use', async context => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-package-path-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const originals = Object.fromEntries(['HALO_ACCEPTANCE_MODE', 'HALO_E2E_PACKAGED_APP'].map(name => [name, process.env[name]]))
  context.after(() => { for (const [name, value] of Object.entries(originals)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } })
  const compiled = path.join(directory, 'fixture.mjs')
  await build({ entryPoints: [path.join(repository, 'tests/e2e/fixtures/electron-packaged.ts')], outfile: compiled, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'no-electron-launch', setup(build) {
    build.onResolve({ filter: /^(playwright|\.\/browser-site|\.\/electron)$/ }, args => ({ path: args.path, namespace: 'path-fixture' }))
    build.onLoad({ filter: /.*/, namespace: 'path-fixture' }, args => ({ loader: 'js', contents: args.path === 'playwright' ? 'export const _electron={launch(){throw new Error("Unexpected GUI launch")}}' : args.path === './browser-site' ? 'export const test={extend(){return {}}};export const expect={};' : 'export function createTestConfigDir(){throw new Error("Unexpected profile creation")};export function cleanupTestConfigDir(){}' }))
  } }] })
  const { packagedAppPath } = await import(pathToFileURL(compiled).href)
  delete process.env.HALO_E2E_PACKAGED_APP
  process.env.HALO_ACCEPTANCE_MODE = 'deterministic'
  assert.throws(packagedAppPath, /require a controlled HALO_E2E_PACKAGED_APP/)
  process.env.HALO_E2E_PACKAGED_APP = path.join(directory, 'controlled-app')
  assert.equal(packagedAppPath(), path.join(directory, 'controlled-app'))
  delete process.env.HALO_ACCEPTANCE_MODE
  delete process.env.HALO_E2E_PACKAGED_APP
  assert.match(packagedAppPath(), /[/\\]dist[/\\]/)
})
