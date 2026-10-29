import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-app-lifecycle-'))
after(() => fs.rm(directory, { recursive: true, force: true }))
const fixture = fileURLToPath(new URL('../../e2e/fixtures/acceptance-app.ts', import.meta.url))
const compiled = path.join(directory, 'fixture.mjs')
const childScript = `
const fs=require('node:fs');const file=process.argv[1];
process.on('message',message=>{
 if(message==='inspect')process.send({exists:fs.existsSync(file),content:fs.existsSync(file)?fs.readFileSync(file,'utf8'):null});
 if(message==='quit')setTimeout(()=>process.exit(0),Number(process.argv[2]||0));
});
process.send({ready:true});
`
const electron = `
import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {once} from 'node:events';
export const state={settings:{},children:[],handles:[],closeCalls:[],processReads:0,cleanupCalls:[],cleanupSnapshots:[],attachments:[]};
export function getAppEntryPath(){return 'synthetic-app-entry.cjs'}
export function createTestConfigDir(){const profile=path.join(state.settings.root,'profile');state.profile=profile;fs.mkdirSync(path.join(profile,'.halo','logs'),{recursive:true});fs.writeFileSync(path.join(profile,'.halo','config.json'),'{}');fs.writeFileSync(path.join(profile,'.halo','logs','main.log'),'Owned fixture log');fs.writeFileSync(path.join(profile,'repository.txt'),'Preserve this active repository');return profile;}
export function cleanupTestConfigDir(profile){state.cleanupCalls.push(profile);state.cleanupSnapshots.push(state.children.map(child=>({pid:child.pid,exitCode:child.exitCode,signalCode:child.signalCode})));fs.rmSync(profile,{recursive:true});}
export async function launchElectronApp(entry,profile){
 const index=state.children.length;
 const child=spawn(process.execPath,['-e',${JSON.stringify(childScript)},path.join(profile,'repository.txt'),String(state.settings.exitDelayMs??0)],{stdio:['ignore','pipe','pipe','ipc']});
 child.stdout.resume();child.stderr.resume();state.children.push(child);await once(child,'message');
 if(state.settings.launchFailureAt===index)throw state.settings.launchFailure;
 let disposed=false;child.once('exit',()=>{disposed=true});
 const window={waitForLoadState:async()=>{},evaluate:async()=>({success:true,data:{activeEngine:'halo',degradedFrom:null}}),isClosed:()=>disposed,screenshot:async()=>{if(state.settings.screenshotFailure)throw state.settings.screenshotFailure}};
 const app={
  process(){state.processReads++;if(disposed)throw new TypeError("Cannot read properties of undefined (reading '_object')");return child},
  firstWindow:async()=>{if(state.settings.firstWindowFailureAt===index)throw state.settings.firstWindowFailure;return window},
  evaluate:async()=>({packaged:false,platform:process.platform,arch:process.arch}),
  close:async()=>{state.closeCalls.push(index);if(state.settings.rejectCloseAt===index)throw state.settings.closeFailure;const exited=once(child,'exit');child.send('quit');if(!state.settings.closeReturnsBeforeExit)await exited;},
 };
 state.handles.push(app);return app;
}
`
await build({ stdin: { contents: `export {test} from ${JSON.stringify(fixture)};export {state} from 'fixture-state';`, resolveDir: path.dirname(fixture), sourcefile: 'lifecycle-entry.ts' }, outfile: compiled, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'real-process-fixture-boundaries', setup(build) {
  build.onResolve({ filter: /^(@playwright\/test|\.\/electron|\.\/acceptance-model|fixture-state)$/ }, args => ({ path: args.path === 'fixture-state' ? './electron' : args.path, namespace: 'lifecycle-fixture' }))
  build.onLoad({ filter: /.*/, namespace: 'lifecycle-fixture' }, args => ({ loader: 'js', contents: args.path === './electron' ? electron : args.path === '@playwright/test' ? `import assert from 'node:assert/strict';export const test={extend(value){return value}};export function expect(value){return {toMatchObject(expected){assert.deepEqual(value,expected)},toEqual(expected){assert.deepEqual(value,expected)}}}` : 'export async function startAcceptanceModel(){throw new Error("Unexpected model launch")}' }))
} }] })
const { test: fixtureDefinition, state } = await import(pathToFileURL(compiled).href)

async function workspace(context, settings = {}) {
  const root = await fs.mkdtemp(path.join(directory, 'run-'))
  state.settings = { root, ...settings }
  for (const key of ['children', 'handles', 'closeCalls', 'cleanupCalls', 'cleanupSnapshots', 'attachments']) state[key] = []
  state.processReads = 0
  context.after(async () => {
    for (const child of state.children) {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close')
        child.kill('SIGKILL')
        await closed
      }
    }
    await fs.rm(root, { recursive: true, force: true })
  })
  return {
    root,
    async run(use = async () => {}) {
      const info = { outputPath: name => path.join(root, name), attach: async (name, attachment) => { if (name === settings.attachmentFailureAt) throw settings.attachmentFailure; state.attachments.push({ name, attachment }) } }
      return fixtureDefinition.acceptanceApp({ model: { url: 'http://127.0.0.1:9', exchanges: [], errors: [] } }, use, info)
    },
    async inspect(index = 0) {
      const child = state.children[index]
      assert.equal(child.exitCode, null)
      assert.equal(child.signalCode, null)
      process.kill(child.pid, 0)
      const response = once(child, 'message')
      child.send('inspect')
      return (await response)[0]
    },
  }
}

const exists = file => fs.access(file).then(() => true, () => false)

test('successful restarts wait for actual child exit before afterClose and delete data only after both instances exit', async context => {
  const selected = await workspace(context, { closeReturnsBeforeExit: true, exitDelayMs: 50 })
  let callbacks = 0
  await selected.run(async session => {
    await session.restart(async profile => {
      callbacks++
      assert.equal(state.children[0].exitCode, 0)
      assert.equal(await exists(path.join(profile, 'repository.txt')), true)
      assert.equal(state.children.length, 1, 'the next application cannot start before afterClose')
    })
  })
  assert.equal(callbacks, 1)
  assert.deepEqual(state.closeCalls, [0, 1])
  assert.equal(state.processReads, 2, 'disposed Playwright facades must never be queried again')
  assert.equal(state.cleanupCalls.length, 1)
  assert(state.cleanupSnapshots[0].every(child => child.exitCode === 0))
  assert.equal(await exists(state.profile), false)
})

test('a screenshot failure still closes the real child and preserves the original failure', async context => {
  const failure = new Error('Synthetic screenshot failure')
  const selected = await workspace(context, { screenshotFailure: failure })
  await assert.rejects(selected.run(), error => error === failure)
  assert.deepEqual(state.closeCalls, [0])
  assert.equal(state.children[0].exitCode, 0)
  assert.equal(await exists(state.profile), false)
  assert(state.attachments.some(item => item.name === 'application-main-log'))
})

test('a close rejection retains the still-running child profile and repository bytes', async context => {
  const failure = new Error('Synthetic close rejection')
  const selected = await workspace(context, { rejectCloseAt: 0, closeFailure: failure })
  await assert.rejects(selected.run(), error => error === failure)
  assert.equal(state.cleanupCalls.length, 0)
  assert.deepEqual(await selected.inspect(), { exists: true, content: 'Preserve this active repository' })
})

test('a successful launch is registered even when firstWindow fails, and the original startup failure survives safe cleanup', async context => {
  const failure = new Error('Synthetic firstWindow failure')
  const selected = await workspace(context, { firstWindowFailureAt: 0, firstWindowFailure: failure })
  let used = false
  await assert.rejects(selected.run(async () => { used = true }), error => error === failure)
  assert.equal(used, false)
  assert.deepEqual(state.closeCalls, [0])
  assert.equal(state.children[0].exitCode, 0)
  assert.equal(await exists(state.profile), false)
})

test('a failed replacement window closes the newly registered instance even though session.app still names the old one', async context => {
  const failure = new Error('Synthetic replacement window failure')
  const selected = await workspace(context, { firstWindowFailureAt: 1, firstWindowFailure: failure })
  await assert.rejects(selected.run(session => session.restart()), error => error === failure)
  assert.deepEqual(state.closeCalls, [0, 1])
  assert(state.children.every(child => child.exitCode === 0))
  assert.equal(state.processReads, 2)
  assert.equal(await exists(state.profile), false)
})

test('a launch rejection without an application handle never deletes an unknown live process profile', async context => {
  const failure = new Error('Synthetic launch response lost')
  const selected = await workspace(context, { launchFailureAt: 0, launchFailure: failure })
  await assert.rejects(selected.run(), error => error === failure)
  assert.equal(state.closeCalls.length, 0)
  assert.equal(state.cleanupCalls.length, 0)
  assert.deepEqual(await selected.inspect(), { exists: true, content: 'Preserve this active repository' })
})

test('an unknown replacement launch prevents cleanup even after every previously registered instance exited', async context => {
  const failure = new Error('Synthetic replacement launch response lost')
  const selected = await workspace(context, { launchFailureAt: 1, launchFailure: failure })
  await assert.rejects(selected.run(session => session.restart()), error => error === failure)
  assert.equal(state.children[0].exitCode, 0)
  assert.deepEqual(state.closeCalls, [0])
  assert.equal(state.cleanupCalls.length, 0)
  assert.deepEqual(await selected.inspect(1), { exists: true, content: 'Preserve this active repository' })
})

test('body, screenshot and close failures are all retained while active data stays readable', async context => {
  const body = new Error('Synthetic body failure')
  const screenshot = new Error('Synthetic screenshot failure')
  const close = new Error('Synthetic close failure')
  const selected = await workspace(context, { screenshotFailure: screenshot, rejectCloseAt: 0, closeFailure: close })
  await assert.rejects(selected.run(async () => { throw body }), error => error instanceof AggregateError && error.errors.includes(body) && error.errors.includes(screenshot) && error.errors.includes(close))
  assert.deepEqual(state.closeCalls, [0])
  assert.equal(state.cleanupCalls.length, 0)
  assert.deepEqual(await selected.inspect(), { exists: true, content: 'Preserve this active repository' })
})

test('evidence export failure cannot prevent a confirmed-exit cleanup or erase its failure', async context => {
  const failure = new Error('Synthetic evidence export failure')
  const selected = await workspace(context, { attachmentFailureAt: 'scripted-model-exchanges', attachmentFailure: failure })
  await assert.rejects(selected.run(), error => error === failure)
  assert.equal(state.children[0].exitCode, 0)
  assert.equal(state.cleanupCalls.length, 1)
  assert.equal(await exists(state.profile), false)
})
