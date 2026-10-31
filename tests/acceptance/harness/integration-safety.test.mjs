import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { cleanEnvironment } from '../../../scripts/acceptance/lib/execution.mjs'
import { loadLiveConfig } from '../../../scripts/acceptance/lib/live-config.mjs'
import { makePlan } from '../../../scripts/acceptance/lib/planner.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

test('custom provider credentials are removed before discovery and deterministic execution', () => {
  const original = { PATH: '/bin', HOME: '/test-home', ACCEPTANCE_PROVIDER_TOKEN: 'synthetic-dedicated-key', GOOGLE_API_KEY: 'synthetic-personal-key', vendorCredential: 'synthetic-private-credential', HALO_TEST_API_KEY: 'synthetic-old-test-key' }
  const environment = cleanEnvironment(original)
  for (const name of ['ACCEPTANCE_PROVIDER_TOKEN', 'GOOGLE_API_KEY', 'vendorCredential', 'HALO_TEST_API_KEY']) assert.ok(!environment[name], `${name} must not reach a test worker`)
  assert.equal(original.ACCEPTANCE_PROVIDER_TOKEN, 'synthetic-dedicated-key')
  assert.equal(environment.PATH, '/bin')
})

test('Git configuration is removed atomically without breaking ignored-output checks in cluster workers', async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-git-environment-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  assert.equal(spawnSync('git', ['init', '--quiet', root]).status, 0)
  await fs.writeFile(path.join(root, '.gitignore'), 'output/\n')
  const source = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: 'Authorization: synthetic-private-value' }
  const environment = cleanEnvironment(source)
  for (const name of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) assert.equal(environment[name], undefined)
  assert.equal(source.GIT_CONFIG_COUNT, '1')
  const { clusterEnvironment } = await import('../../../scripts/acceptance/adapters/cluster.mjs')
  const worker = await clusterEnvironment(root, 'none', environment)
  const check = spawnSync('git', ['check-ignore', '--quiet', 'output/result.json'], { cwd: root, env: worker })
  assert.equal(check.status, 0, check.stderr?.toString())
  assert.equal(worker.GIT_CONFIG_VALUE_0, undefined)
})

test('the live configuration public identity contains limits but never the dedicated credential', async context => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-live-config-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'live.json')
  await fs.writeFile(file, JSON.stringify({ upstream: 'http://127.0.0.1:9/v1', protocol: 'openai', model: 'test-model', apiKeyEnv: 'ACCEPTANCE_PROVIDER_TOKEN' }))
  const value = await loadLiveConfig(file, { requireCredential: true, environment: { ACCEPTANCE_PROVIDER_TOKEN: 'synthetic-dedicated-key' } })
  assert.equal(value.apiKey, 'synthetic-dedicated-key')
  assert.equal(JSON.stringify(value.public).includes(value.apiKey), false)
  assert.deepEqual(value.public.limits, { maxRequests: 8, maxOutputTokens: 1024, maxInputBytes: 128 * 1024, timeoutMs: 120000 })
})

for (const { contactsBroker, integrityFault } of [
  { contactsBroker: false },
  { contactsBroker: true },
  { contactsBroker: true, integrityFault: 'source' },
  { contactsBroker: true, integrityFault: 'build' },
  { contactsBroker: true, integrityFault: 'unexpected-test' },
]) test(`live evidence requires a matching model response and stable execution inputs (${integrityFault ?? (contactsBroker ? 'with response' : 'without response')})`, async context => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-live-receipt-'))
  const upstream = createServer((_request, response) => response.end('{"choices":[{"message":{"role":"assistant","content":"verified"}}]}'))
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  context.after(async () => {
    const stopped = new Promise(resolve => upstream.close(resolve))
    upstream.closeAllConnections()
    await stopped
    await fs.rm(directory, { recursive: true, force: true })
  })
  const variable = 'ACCEPTANCE_INTEGRATION_KEY'
  const previous = process.env[variable]
  process.env[variable] = 'synthetic-model-key-only'
  context.after(() => { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous })
  const liveConfigFile = path.join(directory, 'live.json')
  await fs.writeFile(liveConfigFile, JSON.stringify({ upstream: `http://127.0.0.1:${upstream.address().port}/v1`, protocol: 'openai', model: 'test-model', apiKeyEnv: variable, maxRequests: 1 }))
  const revision = { commit: 'a'.repeat(40), dirty: false, worktreeHash: 'b'.repeat(64) }
  const scenario = { id: 'chat.live', storyId: 'chat.story', module: 'chat', title: 'Live inference', basis: 'documented', profiles: ['live'], platforms: [process.platform], variants: {}, evidence: 'live-model', mode: 'live', automation: 'automated', requirements: ['live-model'], verifies: ['reply'] }
  const catalog = { hash: 'c'.repeat(64), modules: [{ id: 'chat', paths: ['src/**'], dependsOn: [] }], cases: [scenario], approvals: [] }
  const tests = [{ id: 'live-test', title: 'Live test', titlePath: ['Live test'], file: 'tests/e2e/fake.spec.ts', project: 'acceptance', bindings: [{ caseId: scenario.id, evidence: scenario.evidence, mode: scenario.mode, variant: {} }] }]
  const manifest = { version: 1, catalogHash: catalog.hash, revision, tests }
  const config = await loadLiveConfig(liveConfigFile)
  const plan = makePlan(catalog, manifest, { profile: 'live', platform: process.platform, allowLive: true, revision, live: config.public })
  const processStub = `
    import fs from 'node:fs/promises';import path from 'node:path';
    export const redact = value => String(value);
    export async function execute(root,args,{environment}) {
      const tests = args.includes('--list') ? ${JSON.stringify(tests)} : JSON.parse(await fs.readFile(environment.HALO_ACCEPTANCE_SELECTION_FILE,'utf8'));
      const start = Date.now();
      if (${contactsBroker} && !args.includes('--list')) {
        const response = await fetch(environment.HALO_TEST_API_URL+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+environment.HALO_TEST_API_KEY,'content-type':'application/json'},body:JSON.stringify({model:'test-model',messages:[{role:'user',content:'Verify the bounded route'}]})});
        if (!response.ok) throw new Error('The local budget broker rejected the test');
        await response.text();
      }
      const events = [{type:'begin',tests}, ...args.includes('--list') ? [] : tests.map(test=>({type:'test',id:test.id,bindings:test.bindings,status:'passed',retry:0,startedAt:new Date(start).toISOString(),duration:Date.now()-start+1,isolation:['brokered-fresh-profile'],errors:[],attachments:[]})), {type:'end',status:'passed'}];
      if (${integrityFault === 'unexpected-test'} && !args.includes('--list')) events.push({type:'test',id:'unexpected-test',bindings:[],status:'passed'});
      await fs.mkdir(path.dirname(environment.HALO_ACCEPTANCE_REPORT),{recursive:true});
      await fs.appendFile(environment.HALO_ACCEPTANCE_REPORT,events.map(event=>JSON.stringify(event)).join('\\n')+'\\n');
      return {code:0,timedOut:false,log:''};
    }`
  const stubs = {
    './source.mjs': `let calls=0;export async function sourceIdentity(){calls++;return {...${JSON.stringify(revision)},...(${integrityFault === 'source'} && calls>2?{worktreeHash:'changed-after-tests'}:{})}}`,
    './build.mjs': `let calls=0;export async function verifyBuild(){calls++;if(${integrityFault === 'build'} && calls>1)throw new Error('Application build output changed after the controlled build');return {id:'build',builtAt:'2026-01-01T00:00:00Z',inputs:{rootSha256:'inputs'},artifacts:{rootSha256:'artifacts'},sdk:{state:'absent'},platform:process.platform,architecture:process.arch,node:process.versions.node}}`,
    './process.mjs': processStub,
    '../adapters/cluster.mjs': 'export async function discoverClusterTests(){return []};export async function executeClusterTests(){throw new Error("Unexpected cluster execution")}',
  }
  const compiled = path.join(directory, 'execution.mjs')
  await fs.symlink(path.join(repository, 'node_modules'), path.join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  await build({ entryPoints: [path.join(repository, 'scripts/acceptance/lib/execution.mjs')], outfile: compiled, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent', plugins: [{ name: 'isolated-run-facilities', setup(build) {
    build.onResolve({ filter: /^\.\/(source|build|process)\.mjs$/ }, args => args.importer.endsWith('/execution.mjs') ? { path: args.path, namespace: 'run-facility' } : undefined)
    build.onResolve({ filter: /^\.\.\/adapters\/cluster\.mjs$/ }, args => args.importer.endsWith('/execution.mjs') ? { path: args.path, namespace: 'run-facility' } : undefined)
    build.onLoad({ filter: /.*/, namespace: 'run-facility' }, args => ({ contents: stubs[args.path], loader: 'js' }))
  } }] })
  const { runPlan } = await import(pathToFileURL(compiled).href)
  const result = await runPlan(directory, catalog, plan, path.join(directory, 'run'), { liveConfigFile })
  assert.equal(result.liveUsage.upstreamRequests, contactsBroker ? 1 : 0)
  if (integrityFault) {
    assert.equal(result.status, 'failed')
    assert.equal(result.evidenceIntegrity.valid, false)
    assert.equal(result.summary.passed, 0)
    assert.equal(result.cases[0].status, 'not-run')
    assert.equal(result.cases[0].attempts[0].status, 'passed', 'raw test evidence remains available for diagnosis')
    assert.match(result.cases[0].reason, /diagnostic only/)
  } else if (contactsBroker) {
    assert.equal(result.status, 'passed')
    assert.equal(result.evidenceIntegrity.valid, true)
  }
  else assert.notEqual(result.status, 'passed', 'a passing test event without any brokered model execution is not live-model evidence')
})
