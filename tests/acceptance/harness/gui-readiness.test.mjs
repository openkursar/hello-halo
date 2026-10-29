import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import { probeGuiReadiness } from '../../../scripts/acceptance/lib/gui-readiness.mjs'

async function fixture(context, mode = 'ready') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-gui-contract-')))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const write = async (name, value) => {
    const file = path.join(root, name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, value)
  }
  await write('package.json', '{"type":"module"}')
  await write('node_modules/electron/package.json', '{"name":"electron","version":"0.0.0-fixture","main":"index.cjs"}')
  await write('node_modules/electron/index.cjs', `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, 'unexpected-runtime-download'))},'must not execute');throw new Error('Electron installer entry must not run during readiness');`)
  await write('node_modules/electron/path.txt', 'fixture-runtime')
  await write('node_modules/electron/dist/fixture-runtime', 'Synthetic dependency path; no GUI executable is launched in this test.')
  await write('node_modules/playwright/package.json', '{"name":"playwright","version":"0.0.0-fixture","type":"module","main":"index.mjs"}')
  await write('node_modules/playwright/index.mjs', `
import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {once} from 'node:events';
const root=${JSON.stringify(root)},mode=${JSON.stringify(mode)};
export const _electron={async launch(options){
  fs.copyFileSync(options.args[0],path.join(root,'generated-probe.cjs'));
  fs.writeFileSync(path.join(root,'launch.json'),JSON.stringify({executable:options.executablePath,home:options.env.HOME,credential:options.env.PROBE_GUI_SECRET,runAsNode:options.env.ELECTRON_RUN_AS_NODE,proxy:options.env.HTTPS_PROXY}));
  if(mode==='launch-failed')throw new Error('Synthetic launch failure '+process.env.PROBE_GUI_SECRET);
  const program=mode==='not-ready-forced'?'const {spawn}=require("node:child_process");const fs=require("node:fs");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});fs.writeFileSync('+JSON.stringify(path.join(root,'descendant.pid'))+',String(child.pid));setInterval(()=>{},1000);':'setInterval(()=>{},1000);';
  const child=spawn(process.execPath,['-e',program],{detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],env:options.env});await once(child,'spawn');
  fs.writeFileSync(path.join(root,'owned.pid'),String(child.pid));
  let clicked=false;
  const page={waitForLoadState:async()=>{},getByRole:(role,options)=>({click:async()=>{if(role!=='button'||options.name!=='Confirm readiness')throw new Error('Wrong probe control');if(mode!=='ineffective-click')clicked=true}}),locator:()=>({textContent:async()=>clicked?'Ready':'Waiting'}),screenshot:async({path:file})=>fs.writeFileSync(file,'synthetic screenshot')};
  const app={isReady:()=>!mode.startsWith('not-ready'),whenReady:()=>mode.startsWith('not-ready')?new Promise(()=>{}):Promise.resolve()};
  return {process:()=>child,evaluate:async fn=>fn({app}),firstWindow:async()=>mode==='no-window'?new Promise(()=>{}):page,close:()=>{if(mode==='not-ready-forced')return new Promise(()=>{});child.kill('SIGTERM');return Promise.resolve()}};
}};
`)
  return { root, write }
}

test('readiness requires an actual click outcome and retains evidence separate from product results', async context => {
  const { root } = await fixture(context)
  const original = process.env.PROBE_GUI_SECRET
  process.env.PROBE_GUI_SECRET = 'synthetic-private-probe-credential'
  context.after(() => { if (original === undefined) delete process.env.PROBE_GUI_SECRET; else process.env.PROBE_GUI_SECRET = original })
  const result = await probeGuiReadiness(root, { timeoutMs: 3000 })
  assert.equal(result.kind, 'host-gui-readiness')
  assert.equal(result.ready, true)
  assert.deepEqual(result.observations, { electronConnected: true, appReady: true, windowCreated: true, clickConfirmed: true })
  assert.equal(result.cleanup.complete, true)
  assert.equal(result.cleanup.forced, false)
  const launch = JSON.parse(await fs.readFile(path.join(root, 'launch.json'), 'utf8'))
  assert.equal(launch.credential, '')
  assert.notEqual(launch.home, process.env.HOME)
  assert.equal(launch.runAsNode, undefined)
  assert.equal(launch.proxy, undefined)
  const directory = path.join(root, result.evidence.directory)
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'readiness.json'), 'utf8')), JSON.parse(JSON.stringify(result)))
  execFileSync(process.execPath, ['--check', path.join(root, 'generated-probe.cjs')])
  const lifecycle = []
  runInNewContext(await fs.readFile(path.join(root, 'generated-probe.cjs'), 'utf8'), {
    require: name => name === 'node:fs'
      ? { appendFileSync: (_file, line) => lifecycle.push(line) }
      : { app: { isReady: () => false, setPath() {}, commandLine: { appendSwitch() {} }, whenReady: () => new Promise(() => {}), on() {} } },
  })
  assert.equal(JSON.parse(lifecycle[0]).phase, 'started')
  assert.equal(JSON.parse(lifecycle[0]).appReady, false)
  await assert.rejects(fs.access(path.join(directory, 'profile')), { code: 'ENOENT' })
  await assert.rejects(fs.access(path.join(root, 'unexpected-runtime-download')), { code: 'ENOENT' })
  await assert.rejects(probeGuiReadiness(root, { outputDirectory: result.evidence.directory }), { code: 'EEXIST' })
})

for (const [mode, phase] of [['not-ready', 'app-ready'], ['no-window', 'window'], ['ineffective-click', 'click']]) {
  test(`${mode} is host unavailability even though Electron launch connected`, async context => {
    const { root } = await fixture(context, mode)
    const result = await probeGuiReadiness(root, { timeoutMs: 100 })
    assert.equal(result.ready, false)
    assert.equal(result.failure.stage, phase)
    assert.equal(result.observations.electronConnected, true)
    assert.equal(result.observations.clickConfirmed, false)
    assert.equal(result.cleanup.complete, true)
    const pid = Number(await fs.readFile(path.join(root, 'owned.pid'), 'utf8'))
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  })
}

test('a stalled non-ready app and its owned descendant are collected without becoming GUI-ready', { skip: process.platform === 'win32' }, async context => {
  const { root } = await fixture(context, 'not-ready-forced')
  const result = await probeGuiReadiness(root, { timeoutMs: 150 })
  assert.equal(result.ready, false)
  assert.equal(result.failure.stage, 'app-ready')
  assert.equal(result.observations.appReady, false)
  assert.equal(result.cleanup.forced, true)
  assert.equal(result.cleanup.complete, true)
  for (const file of ['owned.pid', 'descendant.pid']) {
    const pid = Number(await fs.readFile(path.join(root, file), 'utf8'))
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  }
})

test('an unprepared Electron runtime fails before invoking any auto-download entry', async context => {
  const { root } = await fixture(context)
  await fs.rm(path.join(root, 'node_modules/electron/path.txt'))
  const result = await probeGuiReadiness(root)
  assert.equal(result.ready, false)
  assert.equal(result.failure.stage, 'dependencies')
  assert.equal(result.observations.electronConnected, false)
  await assert.rejects(fs.access(path.join(root, 'unexpected-runtime-download')), { code: 'ENOENT' })
  await assert.rejects(fs.access(path.join(root, 'owned.pid')), { code: 'ENOENT' })
})

test('launch diagnostics redact inherited credentials and never count cleanup as verification', async context => {
  const { root } = await fixture(context, 'launch-failed')
  const previous = process.env.PROBE_GUI_SECRET
  process.env.PROBE_GUI_SECRET = 'synthetic-probe-secret-for-redaction'
  context.after(() => { if (previous === undefined) delete process.env.PROBE_GUI_SECRET; else process.env.PROBE_GUI_SECRET = previous })
  const result = await probeGuiReadiness(root)
  assert.equal(result.ready, false)
  assert.equal(result.failure.stage, 'launch')
  assert.equal(result.cleanup.complete, true)
  const log = await fs.readFile(path.join(root, result.evidence.directory, 'probe.log'), 'utf8')
  assert.doesNotMatch(JSON.stringify(result) + log, /synthetic-probe-secret-for-redaction/)
  assert.match(log, /REDACTED/)
})

test('controlled probe output cannot follow a symlink outside its directory', async context => {
  const { root, write } = await fixture(context)
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-gui-outside-'))
  context.after(() => fs.rm(outside, { recursive: true, force: true }))
  await write('tests/acceptance/output/placeholder', '')
  await fs.symlink(outside, path.join(root, 'tests/acceptance/output/linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(probeGuiReadiness(root, { outputDirectory: 'tests/acceptance/output/linked/nested/probe' }), /directory link/)
  assert.deepEqual(await fs.readdir(outside), [])
})
