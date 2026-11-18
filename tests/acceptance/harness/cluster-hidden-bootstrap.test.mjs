import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import vm from 'node:vm'
import { prepareNodeEntry, verifyHiddenNodeFinal, waitHiddenNodeReady } from '../../../scripts/cluster/node-bootstrap.mjs'

test('hidden forced shutdown fails only after cleanup and absence checks', async () => {
  const source = fs.readFileSync(new URL('../../../scripts/cluster/launch-nodes.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('    const remaining = pids.filter(alive)')
  const end = source.indexOf('\n  }', start)
  const cleanup = source.slice(start, end)
  for (const hidden of [false, true]) {
    const killed = []
    const context = { pids: [42], alive: pid => !killed.includes(pid), WARN: () => {}, setTimeout: done => done(), process: { env: { HALO_E2E_HIDDEN_WINDOWS: hidden ? '1' : '' }, kill: pid => killed.push(pid) } }
    const result = vm.runInNewContext(`(async () => { ${cleanup} })()`, context)
    if (hidden) await assert.rejects(result, /required forced shutdown/)
    else await result
    assert.deepEqual(killed, [42])
  }
})

test('hidden cluster bootstraps stay outside build outputs and preserve the application identity', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-hidden-node-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const entry = path.join(directory, 'out', 'main', 'index.cjs')
  const node = path.join(directory, 'profiles', 'node-1')
  assert.equal(prepareNodeEntry(entry, node, {}), entry)
  assert.throws(() => prepareNodeEntry(entry, node, { HALO_E2E_HIDDEN_WINDOWS: '1', HALO_E2E_PACKAGED_APP: 'app' }), /controlled source bootstrap/)
  const environment = { HALO_E2E_HIDDEN_WINDOWS: '1' }
  const first = prepareNodeEntry(entry, node, environment)
  const second = prepareNodeEntry(entry, node, environment)
  assert.notEqual(first, second)
  assert.equal(path.dirname(first), node)
  const source = fs.readFileSync(first, 'utf8')
  assert(source.includes(`app.setAppPath(${JSON.stringify(path.dirname(entry))})`))
  assert(source.indexOf('hidden-windows.cjs') < source.indexOf('import('))
  assert(source.includes('app.isPackaged'))
  assert(source.includes('window.isVisible()'))
  assert(source.includes('window.isFocused()'))
  assert.equal(fs.existsSync(path.dirname(entry)), false)
})

test('generated bootstraps execute the real hidden fixture before source loading and quit on SIGTERM', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-hidden-execute-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const fake = path.join(directory, 'fake-electron.cjs')
  fs.writeFileSync(fake, `const {EventEmitter}=require('node:events');
const app=new EventEmitter();let appPath;const windows=[];
app.setAppPath=value=>appPath=value;app.getAppPath=()=>appPath;app.setPath=()=>{};
app.quit=()=>{app.emit('before-quit');for(const window of windows){window.emit('close');window.destroyed=true;window.emit('closed')}windows.length=0;for(let i=0;i<20;i++)app.emit('before-quit');process.exit(0)};
class BrowserWindow extends EventEmitter {constructor(options){super();this.id=1;this.options=options;this.webContents=new EventEmitter();windows.push(this);app.emit('browser-window-created',{},this)}isDestroyed(){return this.destroyed===true}isVisible(){return this.options.show!==false}isFocused(){return this.options.focusable!==false}show(){throw Error('native show')}focus(){throw Error('native focus')}static getAllWindows(){return windows}}
const electron={app,BrowserWindow};const Module=require('node:module');const load=Module._load;Module._load=function(name,...args){return name==='electron'||name==='electron/main'?electron:load.call(this,name,...args)};`)
  const entry = path.join(directory, 'product.cjs')
  fs.writeFileSync(entry, `const {BrowserWindow}=require('electron');const window=new BrowserWindow({show:true,focusable:true});window.show();window.focus();window.webContents.emit('did-finish-load');console.log('ready');setInterval(()=>{},1000);`)
  for (let attempt = 0; attempt < 2; attempt++) {
    const node = path.join(directory, 'node')
    const bootstrap = prepareNodeEntry(entry, node, { HALO_E2E_HIDDEN_WINDOWS: '1' })
    const child = spawn(process.execPath, ['--require', fake, bootstrap], { stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = once(child, 'exit')
    context.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`Synthetic bootstrap exited before readiness: ${code}`))) })
    const ready = await waitHiddenNodeReady(node, child.pid, entry, Date.now() + 2000, { HALO_E2E_HIDDEN_WINDOWS: '1' })
    assert.equal(ready.phase, 'did-finish-load')
    assert.equal(ready.windows[0].loaded, true)
    child.kill('SIGTERM')
    assert.deepEqual(await exited, [0, null])
    const record = verifyHiddenNodeFinal(node, child.pid, entry)
    assert.equal(record.state.preventedPresentations, 2)
    assert.equal(record.windows[0].loaded, true)
    assert.equal(record.windows[0].closed, true)
    assert.equal(record.history.length, 16)
    assert.equal(record.history.at(-1).liveWindowCount, 0)
    assert.equal(record.presented, false)
  }
})

test('hidden readiness rejects stale, malformed and symlinked observations within the existing deadline', async context => {
  const node = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-hidden-ready-'))
  context.after(() => fs.rmSync(node, { recursive: true, force: true }))
  const environment = { HALO_E2E_HIDDEN_WINDOWS: '1' }
  const file = path.join(node, 'hidden-windows-ready.json')
  await waitHiddenNodeReady(node, 42, '/app/index.cjs', Date.now(), {})
  fs.writeFileSync(file, JSON.stringify({ pid: 41 }))
  await assert.rejects(waitHiddenNodeReady(node, 42, '/app/index.cjs', Date.now() + 20, environment), /startup deadline/)
  fs.writeFileSync(file, JSON.stringify({ pid: 42 }))
  await assert.rejects(waitHiddenNodeReady(node, 42, '/app/index.cjs', Date.now() + 20, environment), /invalid final window evidence/)
  fs.renameSync(file, file + '.target')
  fs.symlinkSync(file + '.target', file)
  await assert.rejects(waitHiddenNodeReady(node, 42, '/app/index.cjs', Date.now() + 20, environment), { code: 'ELOOP' })
})

test('final hidden evidence must belong to the current node and contain no visible or focused window', context => {
  const node = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-hidden-final-'))
  context.after(() => fs.rmSync(node, { recursive: true, force: true }))
  const file = path.join(node, 'hidden-windows-final.json')
  assert.throws(() => verifyHiddenNodeFinal(node, 42, '/app/index.cjs'), { code: 'ENOENT' })
  const valid = { pid: 42, phase: 'before-quit', presented: false, appPath: '/app', state: { created: 1 }, windows: [{ visible: false, focused: false, loaded: true }] }
  fs.writeFileSync(file, JSON.stringify(valid))
  assert.deepEqual(verifyHiddenNodeFinal(node, 42, '/app/index.cjs'), valid)
  assert.throws(() => verifyHiddenNodeFinal(node, 43, '/app/index.cjs'), /invalid final window evidence/)
  for (const mutation of [{ presented: true }, { windows: [] }, { windows: [{ visible: false, focused: false, loaded: false }] }]) {
    fs.writeFileSync(file, JSON.stringify({ ...valid, ...mutation }))
    assert.throws(() => verifyHiddenNodeFinal(node, 42, '/app/index.cjs'), /invalid final window evidence/)
  }
  for (const window of [{ visible: true, focused: false }, { visible: false, focused: true }]) {
    fs.writeFileSync(file, JSON.stringify({ ...valid, windows: [window] }))
    assert.throws(() => verifyHiddenNodeFinal(node, 42, '/app/index.cjs'), /invalid final window evidence/)
  }
})
