import assert from 'node:assert/strict'
import { EventEmitter, errorMonitor, once } from 'node:events'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { truncateSync } from 'node:fs'
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
const {EventEmitter}=require('node:events');const app=new EventEmitter();const window=new EventEmitter();window.id=1;let destroyed=false;window.isDestroyed=()=>destroyed;const BrowserWindow={getAllWindows:()=>destroyed?[]:[window]};
process.on('message',message=>{
 if(message&&message.type==='evaluate'){
  try{const result=eval('('+message.source+')')({app,BrowserWindow},message.argument);Promise.resolve(result).then(value=>process.send({evaluated:true,value}),()=>process.send({evaluationFailed:true}));}
  catch{process.send({evaluationFailed:true})}return;
 }
 if(message==='inspect')process.send({exists:fs.existsSync(file),content:fs.existsSync(file)?fs.readFileSync(file,'utf8'):null});
 if(message==='quit')setTimeout(()=>{const event={defaultPrevented:false};app.emit('before-quit',event);window.emit('close',event);destroyed=true;window.emit('closed');app.emit('will-quit',event);app.emit('quit',event,0);process.exit(0)},Number(process.argv[2]||0));
});
process.send({ready:true});
`
const electron = `
import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {EventEmitter,once} from 'node:events';
export const state={settings:{},children:[],handles:[],closeCalls:[],processReads:0,cleanupCalls:[],cleanupSnapshots:[],attachments:[]};
export function getAppEntryPath(){return 'synthetic-app-entry.cjs'}
export function createTestConfigDir(){const profile=path.join(state.settings.root,'profile');state.profile=profile;fs.mkdirSync(path.join(profile,'.halo','logs'),{recursive:true});fs.writeFileSync(path.join(profile,'.halo','config.json'),'{}');fs.writeFileSync(path.join(profile,'.halo','logs','main.log'),'Owned fixture log');fs.writeFileSync(path.join(profile,'repository.txt'),'Preserve this active repository');return profile;}
export function cleanupTestConfigDir(profile){state.cleanupCalls.push(profile);state.cleanupSnapshots.push(state.children.map(child=>({pid:child.pid,exitCode:child.exitCode,signalCode:child.signalCode})));fs.rmSync(profile,{recursive:true});}
export async function launchElectronApp(entry,profile){
 const index=state.children.length;
 const child=spawn(process.execPath,['-e',${JSON.stringify(childScript)},path.join(profile,'repository.txt'),String(state.settings.exitDelayMs??0)],{detached:process.platform!=='win32',stdio:['ignore','pipe','pipe','ipc']});
 child.stdout.resume();child.stderr.resume();state.children.push(child);await once(child,'message');
 if(state.settings.launchFailureAt===index)throw state.settings.launchFailure;
 let disposed=false;child.once('exit',()=>{disposed=true});
 const window={waitForLoadState:async()=>{},evaluate:async()=>({success:true,data:{activeEngine:'halo',degradedFrom:null}}),isClosed:()=>disposed,screenshot:async()=>{if(state.settings.screenshotFailure)throw state.settings.screenshotFailure}};
 const context=new EventEmitter();const app=Object.assign(new EventEmitter(),{
  process(){state.processReads++;if(disposed)throw new TypeError("Cannot read properties of undefined (reading '_object')");return child},
  firstWindow:async()=>{if(state.settings.firstWindowFailureAt===index)throw state.settings.firstWindowFailure;return window},
  context:()=>context,
  evaluate:async(fn,argument)=>{if(argument?.file){if(state.settings.diagnosticInstallFailure)throw state.settings.diagnosticInstallFailure;const reply=once(child,'message');child.send({type:'evaluate',source:fn.toString(),argument});const [result]=await reply;if(result.evaluationFailed)throw new Error('Synthetic main observer installation failed');return result.value;}return {packaged:false,platform:process.platform,arch:process.arch}},
  close:async()=>{state.closeCalls.push(index);if(state.settings.rejectCloseAt===index)throw state.settings.closeFailure;if(state.settings.neverCloseAt===index)return new Promise(()=>{});const exited=once(child,'exit');child.send('quit');if(!state.settings.closeReturnsBeforeExit)await exited;},
 });
 child.once('close',()=>{app.emit('close');context.emit('close')});
 state.handles.push(app);return app;
}
`
await build({ stdin: { contents: `export {test} from ${JSON.stringify(fixture)};export {state} from 'fixture-state';export {observeAcceptanceShutdown,shutdownProcessSnapshot} from './acceptance-shutdown-diagnostics';`, resolveDir: path.dirname(fixture), sourcefile: 'lifecycle-entry.ts' }, outfile: compiled, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'real-process-fixture-boundaries', setup(build) {
  build.onResolve({ filter: /^(@playwright\/test|\.\/electron|\.\/acceptance-model|fixture-state)$/ }, args => ({ path: args.path === 'fixture-state' ? './electron' : args.path, namespace: 'lifecycle-fixture' }))
  build.onLoad({ filter: /.*/, namespace: 'lifecycle-fixture' }, args => ({ loader: 'js', contents: args.path === './electron' ? electron : args.path === '@playwright/test' ? `import assert from 'node:assert/strict';export const test={extend(value){return value}};export function expect(value){return {toMatchObject(expected){assert.deepEqual(value,expected)},toEqual(expected){assert.deepEqual(value,expected)}}}` : 'export async function startAcceptanceModel(){throw new Error("Unexpected model launch")}' }))
} }] })
const { test: fixtureDefinition, state, observeAcceptanceShutdown, shutdownProcessSnapshot } = await import(pathToFileURL(compiled).href)

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
      return fixtureDefinition.acceptanceApp({ model: { url: 'http://127.0.0.1:9', exchanges: [], errors: [] }, diagnoseShutdown: settings.diagnoseShutdown ?? false }, use, info)
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

test('default application fixtures never install passive diagnostics', async context => {
  const selected = await workspace(context)
  assert.deepEqual(fixtureDefinition.diagnoseShutdown, [false, { option: true }])
  await selected.run(async session => {
    assert.equal(state.children[0].listenerCount(errorMonitor), 0)
    assert.equal((await fs.readdir(session.profile)).some(name => name.startsWith('acceptance-shutdown-')), false)
  })
  assert.equal(state.attachments.some(item => item.name === 'application-shutdown-diagnostics'), false)
})

test('opt-in records real child and passive native lifecycle events across restart without querying disposed facades', async context => {
  const selected = await workspace(context, { diagnoseShutdown: true })
  await selected.run(session => session.restart())
  const { applications } = JSON.parse(state.attachments.find(item => item.name === 'application-shutdown-diagnostics').attachment.body)
  assert.equal(applications.length, 2)
  assert.equal(state.processReads, 2)
  assert.deepEqual(state.closeCalls, [0, 1])
  for (const record of applications) {
    assert.equal(record.mainInstalled, true)
    assert.equal(record.final.exitCode, 0)
    assert.deepEqual(record.final.stdio.map(pipe => pipe.fd), [0, 1, 2, 3, 4])
    assert(record.events.some(event => event.event === 'child-exit' && event.code === 0))
    assert(record.attempts.some(attempt => attempt.appClose === 'resolved' && attempt.deadlineMs === 15000 && !attempt.timedOut))
    for (const name of ['observer-installed', 'before-quit', 'window-close', 'window-closed', 'will-quit', 'quit', 'process-exit']) assert(record.main.some(event => event.event === name), name)
    assert(record.main.filter(event => event.event === 'before-quit' || event.event === 'window-close').every(event => event.defaultPrevented === false))
  }
  assert.equal(await exists(state.profile), false)
})

test('a diagnostic setup rejection preserves a simultaneous body failure and still cleans confirmed-exit data', async context => {
  const diagnostic = new Error('Synthetic observer setup failure')
  const body = new Error('Synthetic body failure stays visible')
  const selected = await workspace(context, { diagnoseShutdown: true, diagnosticInstallFailure: diagnostic })
  await assert.rejects(selected.run(async () => { throw body }), error => error instanceof AggregateError && error.errors.includes(body) && error.errors.includes(diagnostic))
  assert.deepEqual(state.closeCalls, [0])
  assert.equal(state.children[0].exitCode, 0)
  assert.equal(await exists(state.profile), false)
})

test('missing native evidence and failed diagnostic export never skip actual process cleanup', async context => {
  const body = new Error('Keep the original body failure')
  const attachment = new Error('Synthetic diagnostic attachment failure')
  const selected = await workspace(context, { diagnoseShutdown: true, attachmentFailureAt: 'application-shutdown-diagnostics', attachmentFailure: attachment })
  await assert.rejects(selected.run(async session => {
    const name = (await fs.readdir(session.profile)).find(name => name.startsWith('acceptance-shutdown-'))
    assert(name)
    await fs.unlink(path.join(session.profile, name))
    throw body
  }), error => error instanceof AggregateError && error.errors.includes(body) && error.errors.includes(attachment) && error.errors.some(item => item.code === 'ENOENT'))
  assert.equal(state.children[0].exitCode, 0)
  assert.equal(state.cleanupCalls.length, 1)
  assert.equal(await exists(state.profile), false)
})

test('an empty native lifecycle record remains an explicit diagnostic failure after safe cleanup', async context => {
  const body = new Error('Preserve the body failure when native evidence is lost')
  const selected = await workspace(context, { diagnoseShutdown: true })
  await assert.rejects(selected.run(async session => {
    const name = (await fs.readdir(session.profile)).find(name => name.startsWith('acceptance-shutdown-'))
    assert(name)
    state.children[0].once('exit', () => truncateSync(path.join(session.profile, name), 0))
    throw body
  }), error => error instanceof AggregateError && error.errors.includes(body) && error.errors.some(item => item.message.includes('does not confirm observer installation')))
  assert.equal(state.children[0].exitCode, 0)
  assert.equal(state.cleanupCalls.length, 1)
  assert.equal(await exists(state.profile), false)
  const record = JSON.parse(state.attachments.find(item => item.name === 'application-shutdown-diagnostics').attachment.body).applications[0]
  assert.equal(record.mainEvidenceUnavailable, true)
  assert(record.events.some(event => event.event === 'child-exit'))
})

test('a live child keeps the original 15 second failure and profile even with diagnostic observation enabled', { timeout: 20000 }, async context => {
  const selected = await workspace(context, { diagnoseShutdown: true, neverCloseAt: 0 })
  const started = Date.now()
  await assert.rejects(selected.run(), /Acceptance application did not close within 15 seconds/)
  assert(Date.now() - started >= 15000)
  assert.equal(state.cleanupCalls.length, 0)
  assert.deepEqual(await selected.inspect(), { exists: true, content: 'Preserve this active repository' })
  const record = JSON.parse(state.attachments.find(item => item.name === 'application-shutdown-diagnostics').attachment.body).applications[0]
  assert.equal(record.attempts[0].deadlineMs, 15000)
  assert.equal(record.attempts[0].timedOut, true)
  assert.equal(record.attempts[0].appClose, 'pending')
  assert.equal(record.attempts[0].atDeadline.exitCode, null)
  assert.equal(record.attempts[0].atDeadline.signalCode, null)
  if (process.platform !== 'win32') assert(record.attempts[0].processGroup.processes.some(item => item.pid === state.children[0].pid))
  assert.equal(state.children[0].listenerCount(errorMonitor), 0, 'observation listeners must be removed after evidence export')
})

test('all pipe observers remain passive and errorMonitor leaves unhandled errors unhandled', async context => {
  const child = spawn(process.execPath, ['-e', "require('node:fs').writeSync(3,'private-third-pipe');require('node:fs').writeSync(4,'private-fourth-pipe');process.send('ready');setInterval(()=>{},1000)"], { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'ipc'] })
  const completion = new Promise(resolve => child.once('close', resolve))
  context.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await completion })
  await once(child, 'message')
  const app = Object.assign(new EventEmitter(), { context: () => new EventEmitter() })
  const before = child.stdio.map(stream => stream ? { flow: stream.readableFlowing, data: stream.listenerCount('data'), errors: stream.listenerCount('error') } : null)
  const observer = observeAcceptanceShutdown(app, child, directory)
  context.after(() => observer.dispose())
  for (const [fd, stream] of child.stdio.entries()) {
    if (!stream) continue
    assert.equal(stream.readableFlowing, before[fd].flow)
    assert.equal(stream.listenerCount('data'), before[fd].data)
    assert.equal(stream.listenerCount('error'), before[fd].errors)
  }
  const failure = new Error('private-error-payload must not be recorded')
  assert.throws(() => child.emit('error', failure), error => error === failure)
  assert.throws(() => child.stdio[4].emit('error', failure), error => error === failure)
  const attempt = observer.begin('teardown', 15000)
  observer.called(attempt)
  child.kill('SIGTERM')
  await completion
  observer.settled(attempt, 'resolved')
  observer.finish(attempt)
  const evidence = await observer.evidence()
  for (const fd of [1, 2, 3, 4]) assert(evidence.events.some(event => event.event === 'stdio-event' && event.fd === fd && event.state === 'close'))
  assert.doesNotMatch(JSON.stringify(evidence), /private-third-pipe|private-fourth-pipe|private-error-payload|setInterval/)
  assert.equal(shutdownProcessSnapshot(child).signalCode, 'SIGTERM')
})

test('a real exited parent with an inherited fd4 remains distinguishable from complete stdio and a pending close promise', async context => {
  const program = "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setTimeout(()=>{},700)'],{stdio:['ignore','ignore','ignore','ignore',4]});child.unref();process.send('ready');process.on('message',()=>process.exit(0))"
  const child = spawn(process.execPath, ['-e', program], { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'ipc'] })
  const completion = new Promise(resolve => child.once('close', resolve))
  context.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await completion })
  await once(child, 'message')
  const app = Object.assign(new EventEmitter(), { context: () => new EventEmitter() })
  const observer = observeAcceptanceShutdown(app, child, directory)
  context.after(() => observer.dispose())
  const attempt = observer.begin('teardown', 100)
  observer.called(attempt)
  const exited = once(child, 'exit')
  child.send('quit')
  await exited
  await new Promise(resolve => setTimeout(resolve, 100))
  observer.deadline(attempt)
  const pendingPipe = await observer.evidence()
  assert.equal(pendingPipe.attempts[0].atDeadline.exitCode, 0)
  assert.equal(pendingPipe.attempts[0].appClose, 'pending')
  assert.equal(pendingPipe.attempts[0].atDeadline.stdio[4].closed, false)
  assert.equal(pendingPipe.events.some(event => event.event === 'child-close'), false)
  await completion
  observer.finish(attempt)
  const closed = await observer.evidence()
  assert.equal(closed.attempts[0].appClose, 'pending', 'pipe completion is not an invented Playwright resolution')
  assert.equal(closed.attempts[0].after.stdio[4].closed, true)
  assert(closed.events.some(event => event.event === 'child-close' && event.code === 0))
})
