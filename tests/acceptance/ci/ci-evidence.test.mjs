import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createEvidenceScope, evidenceScopeVariable, freezeEvidence, verifyEvidenceSource, verifyFrozenEvidence } from '../../../scripts/acceptance/lib/ci-evidence.mjs'
import { execute } from '../../../scripts/acceptance/lib/process.mjs'

const moduleUrl = new URL('../../../scripts/acceptance/lib/ci-evidence.mjs', import.meta.url).href
const identity = { repository: 'example/controller', runId: '100', attempt: '1' }
const revision = 'a'.repeat(40)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const actorProgram = `
import fs from 'node:fs';import path from 'node:path';
import {createEvidenceScope,finishEvidenceScope,beginEvidenceProducer,finishEvidenceProducer,rejectEvidenceSpawn,evidenceScopeVariable} from ${JSON.stringify(moduleUrl)};
const input=JSON.parse(process.argv[1]);let scope,producer;
if(input.pauseRegistration){
  const link=fs.linkSync;
  fs.linkSync=(from,to)=>{
    if(path.basename(path.dirname(to))==='producers'){
      fs.writeFileSync(path.join(input.root,'registration-held'),String(process.pid));
      const deadline=performance.now()+10000;
      while(!fs.existsSync(path.join(input.root,'registration-release'))){
        if(performance.now()>deadline)throw new Error('Synthetic registration gate was not released');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
      }
    }
    return link(from,to);
  };
}
try {
  if(input.role==='owner')scope=createEvidenceScope(input.root,input.identity);
  else producer=beginEvidenceProducer(input.root,'independent writer',{environment:{[evidenceScopeVariable]:input.scopePath},self:true,evidencePaths:[path.join(input.root,'tests/acceptance/output/ci/writer-tail.json')]});
  process.send({ready:true,scope,producer});
}catch(error){process.send({ready:false,code:error.code??'UNAVAILABLE',message:error.message},()=>process.exit(1));}
process.on('message',message=>{
  try {
    if(message.operation==='finish')finishEvidenceScope(scope,{outcome:message.outcome??'failed',exitCode:1});
    else if(message.operation==='intent')producer=beginEvidenceProducer(input.root,'pending spawn',{environment:{[evidenceScopeVariable]:scope.path}});
    else if(message.operation==='register')producer=beginEvidenceProducer(input.root,'late producer',{environment:{[evidenceScopeVariable]:scope.path},self:true});
    else if(message.operation==='close-producer')finishEvidenceProducer(producer,{exitCode:0,cleanupConfirmed:true});
    else if(message.operation==='reject-spawn')rejectEvidenceSpawn(producer,'ENOENT');
    else if(message.operation==='write')fs.writeFileSync(path.join(input.root,'tests/acceptance/output/ci/writer-tail.json'),JSON.stringify({actualWriter:process.pid,finished:true}));
    else if(message.operation!=='exit')throw new Error('Unknown synthetic actor operation');
    process.send({id:message.id,ok:true,scope,producer},()=>{if(message.exit||message.operation==='exit')process.exit(1);});
  }catch(error){process.send({id:message.id,ok:false,code:error.code??'UNAVAILABLE',message:error.message});}
});
`

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-evidence-')))
  const source = path.join(root, 'tests/acceptance/output/ci')
  fs.mkdirSync(source, { recursive: true })
  fs.writeFileSync(path.join(source, 'context.json'), JSON.stringify({ repository: 'example/source', ref: 'main', revision, dirty: false }))
  fs.writeFileSync(path.join(source, 'summary.md'), 'Synthetic evidence prepared before producer completion.\n')
  const children = []
  t.after(async () => {
    for (const record of children) {
      if (record.child.exitCode == null && record.child.signalCode == null) record.child.kill('SIGKILL')
      await record.closed
    }
    fs.rmSync(root, { recursive: true, force: true })
  })
  const actor = async input => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', actorProgram, JSON.stringify({ root, identity, ...input })], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, HALO_ACCEPTANCE_EVIDENCE_SCOPE: undefined } })
    let errors = ''
    child.stdout.resume()
    child.stderr.on('data', chunk => { errors = (errors + String(chunk)).slice(-4096) })
    const closed = once(child, 'close')
    const record = { child, closed }
    children.push(record)
    const pending = new Map()
    let readyResolve
    const ready = new Promise(resolve => { readyResolve = resolve })
    child.on('message', message => {
      if ('ready' in message) readyResolve(message)
      else pending.get(message.id)?.(message)
    })
    const started = await Promise.race([ready, closed.then(() => { throw new Error(`Synthetic evidence actor closed before readiness: ${errors}`) })])
    let sequence = 0
    return {
      ...record, started,
      async command(operation, extra = {}) {
        const id = ++sequence
        const response = new Promise(resolve => pending.set(id, resolve))
        child.send({ id, operation, ...extra })
        const result = await Promise.race([response, closed.then(() => { throw new Error('Synthetic evidence actor closed before its reply') })])
        pending.delete(id)
        if (extra.exit || operation === 'exit') await closed
        return result
      },
    }
  }
  const owner = async () => {
    const value = await actor({ role: 'owner' })
    assert.equal(value.started.ready, true, value.started.message)
    return value
  }
  const completedOwner = async () => {
    const value = await owner()
    assert.equal((await value.command('finish', { exit: true })).ok, true)
    assert.equal(value.child.exitCode, 1)
    return value
  }
  return { root, source, actor, owner, completedOwner }
}

function fileIdentity(file) {
  const value = fs.statSync(file), bytes = fs.readFileSync(file)
  return { inode: value.ino, mode: value.mode & 0o777, mtimeMs: value.mtimeMs, sha256: hash(bytes) }
}

function noFreeze(source) {
  assert.equal(fs.existsSync(path.join(source, 'evidence-freeze.json')), false)
  assert.equal(fs.existsSync(path.join(source, 'producer-completion.json')), false)
}

async function until(check) {
  const deadline = performance.now() + 5000
  while (!check()) {
    if (performance.now() > deadline) throw new Error('Synthetic evidence process did not reach the requested boundary')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('a registration already admitted before owner closure must publish before that owner can finish', { timeout: 15000 }, async t => {
  const f = fixture(t), owner = await f.owner()
  const pending = f.actor({ role: 'writer', scopePath: owner.started.scope.path, pauseRegistration: true })
  await until(() => fs.existsSync(path.join(f.root, 'registration-held')))
  assert.equal(fs.readdirSync(path.join(owner.started.scope.directory, 'producers')).some(name => name.endsWith('.json')), false)
  const finish = await owner.command('finish')
  assert.equal(finish.ok, false)
  assert.match(finish.message, /admission is still in progress/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(owner.started.scope.directory, 'owner.json'))).state, 'running')
  assert.throws(() => freezeEvidence(f.root, { identity }), { code: 'EVIDENCE_UNSETTLED' })
  noFreeze(f.source)
  fs.writeFileSync(path.join(f.root, 'registration-release'), '')
  const writer = await pending
  assert.equal(writer.started.ready, true)
  await owner.command('finish', { exit: true })
  assert.throws(() => freezeEvidence(f.root, { identity }), { code: 'EVIDENCE_UNSETTLED' })
  await writer.command('close-producer', { exit: true })
  assert.equal(freezeEvidence(f.root, { identity }).receipt.completion.producerCount, 1)
})

test('a killed registration holder leaves an unconfirmed admission gate and cannot authorize a freeze', { timeout: 15000 }, async t => {
  const f = fixture(t), owner = await f.owner()
  const pending = f.actor({ role: 'writer', scopePath: owner.started.scope.path, pauseRegistration: true }).catch(error => error)
  await until(() => fs.existsSync(path.join(f.root, 'registration-held')))
  const writerPid = Number(fs.readFileSync(path.join(f.root, 'registration-held'), 'utf8'))
  process.kill(writerPid, 'SIGKILL')
  assert(await pending instanceof Error)
  const lock = path.join(owner.started.scope.directory, 'admission.lock'), before = fileIdentity(lock)
  assert.equal((await owner.command('finish')).ok, false)
  await owner.command('exit')
  assert.throws(() => freezeEvidence(f.root, { identity }), { code: 'EVIDENCE_UNSETTLED' })
  assert.deepEqual(fileIdentity(lock), before)
  noFreeze(f.source)
})

test('a running scoped child cannot redirect its completed log through a late symbolic link', { timeout: 10000 }, async t => {
  const f = fixture(t), scope = createEvidenceScope(f.root, identity)
  const output = path.join(f.source, 'owned.log'), external = path.join(f.root, 'external-sentinel')
  fs.writeFileSync(external, 'unchanged external bytes')
  const program = `const fs=require('node:fs');fs.writeFileSync('ready','');const timer=setInterval(()=>{if(fs.existsSync('release')){clearInterval(timer);console.log('child output')}},10);`
  const child = execute(f.root, ['-e', program], { environment: { [evidenceScopeVariable]: scope.path }, logFile: output, timeoutMs: 4000 })
  const result = child.then(value => ({ value }), error => ({ error }))
  await until(() => fs.existsSync(path.join(f.root, 'ready')))
  fs.symlinkSync(external, output)
  fs.writeFileSync(path.join(f.root, 'release'), '')
  assert.match((await result).error?.message ?? '', /symbolic links/)
  assert.equal(fs.readFileSync(external, 'utf8'), 'unchanged external bytes')
  const record = JSON.parse(fs.readFileSync(path.join(scope.directory, 'producers', fs.readdirSync(path.join(scope.directory, 'producers'))[0])))
  assert.equal(record.state, 'running')
  assert.throws(() => process.kill(record.pid, 0), { code: 'ESRCH' })
})

test('a real owner completion and exit produce a portable frozen payload without inventing a passing run', { timeout: 10000 }, async t => {
  const f = fixture(t)
  await f.completedOwner()
  const frozen = freezeEvidence(f.root, { identity })
  assert.equal(frozen.receipt.revision, revision)
  assert.deepEqual(frozen.receipt.identity, identity)
  assert.deepEqual(frozen.receipt.completion, { outcome: 'failed', producerCount: 0 })
  assert.equal(fs.existsSync(path.join(f.source, 'run/run.json')), false)
  assert.equal(verifyEvidenceSource(f.root, { identity }).freezeSha256, frozen.freezeSha256)
  assert.equal(frozen.freezeSha256, hash(fs.readFileSync(path.join(f.source, 'evidence-freeze.json'))))
  const copy = path.join(f.root, 'offline-copy')
  fs.cpSync(f.source, copy, { recursive: true })
  fs.rmSync(path.join(f.root, 'tests'), { recursive: true })
  assert.equal(verifyFrozenEvidence(copy, { identity }).freezeSha256, frozen.freezeSha256)
})

test('a live owner remains unsettled even after it records finished metadata', { timeout: 10000 }, async t => {
  const f = fixture(t), owner = await f.owner()
  assert.throws(() => freezeEvidence(f.root, { identity }), { code: 'EVIDENCE_UNSETTLED' })
  noFreeze(f.source)
  assert.equal((await owner.command('finish')).ok, true)
  process.kill(owner.child.pid, 0)
  assert.throws(() => freezeEvidence(f.root, { identity }), { code: 'EVIDENCE_UNSETTLED' })
  noFreeze(f.source)
  await owner.command('exit')
  assert.equal(freezeEvidence(f.root, { identity }).receipt.completion.outcome, 'failed')
})

test('SIGKILL cannot replace the missing owner-completion acknowledgement', { timeout: 10000 }, async t => {
  const f = fixture(t), owner = await f.owner()
  owner.child.kill('SIGKILL')
  await owner.closed
  assert.throws(() => freezeEvidence(f.root, { identity }), { code: 'EVIDENCE_UNSETTLED' })
  noFreeze(f.source)
})

test('a registered quiet writer blocks freezing until its real process exits, even when its record says closed', { timeout: 10000 }, async t => {
  const f = fixture(t), owner = await f.owner()
  const writer = await f.actor({ role: 'writer', scopePath: owner.started.scope.path })
  assert.equal(writer.started.ready, true)
  assert.equal(writer.started.producer.record.pid, writer.child.pid)
  assert.equal((await writer.command('close-producer')).ok, true)
  assert.equal((await owner.command('finish', { exit: true })).ok, true)
  assert.throws(() => freezeEvidence(f.root, { identity }), { code: 'EVIDENCE_UNSETTLED' })
  noFreeze(f.source)
  process.kill(writer.child.pid, 0)
  assert.equal((await writer.command('write')).ok, true)
  await writer.command('exit')
  const frozen = freezeEvidence(f.root, { identity })
  assert.equal(frozen.receipt.completion.producerCount, 1)
  assert(frozen.receipt.payload.files.some(file => file.path === 'writer-tail.json'))
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.source, 'writer-tail.json'), 'utf8')).actualWriter, writer.child.pid)
})

test('an owner stops accepting new evidence producers as soon as it finishes', { timeout: 10000 }, async t => {
  const f = fixture(t), owner = await f.owner()
  await owner.command('finish')
  const before = fs.readdirSync(path.join(owner.started.scope.directory, 'producers'))
  const rejected = await owner.command('register')
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'EVIDENCE_UNSETTLED')
  assert.deepEqual(fs.readdirSync(path.join(owner.started.scope.directory, 'producers')), before)
  await owner.command('exit')
})

test('a terminal owner outcome cannot be rewritten from cancelled to passed', { timeout: 10000 }, async t => {
  const f = fixture(t), owner = await f.owner()
  assert.equal((await owner.command('finish', { outcome: 'cancelled' })).ok, true)
  const ownerFile = path.join(owner.started.scope.directory, 'owner.json'), before = fileIdentity(ownerFile)
  const rewritten = await owner.command('finish', { outcome: 'passed' })
  assert.equal(rewritten.ok, false)
  assert.equal(rewritten.code, 'EVIDENCE_UNSETTLED')
  assert.deepEqual(fileIdentity(ownerFile), before)
  await owner.command('exit')
  assert.equal(freezeEvidence(f.root, { identity }).receipt.completion.outcome, 'cancelled')
})

for (const closeIntent of [false, true]) test(`a producer intent without a PID stays unconfirmed (${closeIntent ? 'claimed closed' : 'starting'})`, { timeout: 10000 }, async t => {
  const f = fixture(t), owner = await f.owner()
  const intent = await owner.command('intent')
  assert.equal(intent.ok, true)
  assert.equal(intent.producer.record.pid, null)
  if (closeIntent) await owner.command('close-producer')
  await owner.command('finish', { exit: true })
  assert.throws(() => freezeEvidence(f.root, { identity }), { code: 'EVIDENCE_UNSETTLED' })
  noFreeze(f.source)
})

test('an explicitly rejected spawn can freeze failed preparation without claiming an executed test', { timeout: 10000 }, async t => {
  const f = fixture(t), owner = await f.owner()
  await owner.command('intent')
  assert.equal((await owner.command('reject-spawn')).ok, true)
  await owner.command('finish', { exit: true })
  const frozen = freezeEvidence(f.root, { identity })
  assert.equal(frozen.receipt.completion.outcome, 'failed')
  assert.equal(frozen.receipt.completion.producerCount, 1)
  const completion = JSON.parse(fs.readFileSync(path.join(f.source, 'producer-completion.json'), 'utf8'))
  assert.equal(completion.producers[0].neverStarted, true)
  assert.equal(completion.producers[0].pid, null)
})

for (const wrong of [{ runId: '101' }, { attempt: '2' }, { repository: 'another/controller' }]) test(`a freeze cannot be used for a different ${Object.keys(wrong)[0]}`, { timeout: 10000 }, async t => {
  const f = fixture(t)
  await f.completedOwner()
  freezeEvidence(f.root, { identity })
  assert.throws(() => verifyFrozenEvidence(f.source, { identity: { ...identity, ...wrong } }), { code: 'EVIDENCE_IDENTITY_MISMATCH' })
  assert.throws(() => verifyEvidenceSource(f.root, { identity: { ...identity, ...wrong } }), { code: 'EVIDENCE_IDENTITY_MISMATCH' })
})

test('the captured source revision cannot change between owner completion and freezing', { timeout: 10000 }, async t => {
  const f = fixture(t)
  await f.completedOwner()
  const file = path.join(f.source, 'context.json'), value = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...value, revision: 'b'.repeat(40) }))
  assert.throws(() => freezeEvidence(f.root, { identity }), { code: 'EVIDENCE_CHANGED' })
  noFreeze(f.source)
})

for (const change of ['revision', 'hash', 'late-summary']) test(`frozen evidence refuses ${change} changes`, { timeout: 10000 }, async t => {
  const f = fixture(t)
  await f.completedOwner()
  freezeEvidence(f.root, { identity })
  const file = path.join(f.source, 'evidence-freeze.json'), value = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (change === 'revision') value.revision = 'b'.repeat(40)
  if (change === 'hash') value.payload.files.find(file => file.path === 'summary.md').sha256 = '0'.repeat(64)
  if (change === 'late-summary') fs.appendFileSync(path.join(f.source, 'summary.md'), 'late writer output\n')
  else fs.writeFileSync(file, JSON.stringify(value))
  assert.throws(() => verifyFrozenEvidence(f.source, { identity }), { code: change === 'revision' ? 'EVIDENCE_NOT_FROZEN' : 'EVIDENCE_CHANGED' })
})

test('owner pointers are exclusive and repeated finalization preserves existing completion and freeze bytes', { timeout: 10000 }, async t => {
  const f = fixture(t), owner = await f.owner()
  const pointer = path.join(f.source, 'evidence-owner.json'), original = fileIdentity(pointer)
  const duplicate = await f.actor({ role: 'owner' })
  assert.equal(duplicate.started.ready, false)
  assert.equal(duplicate.started.code, 'EEXIST')
  await duplicate.closed
  assert.deepEqual(fileIdentity(pointer), original)
  await owner.command('finish', { exit: true })
  freezeEvidence(f.root, { identity })
  const files = ['evidence-owner.json', 'producer-completion.json', 'evidence-freeze.json'].map(name => path.join(f.source, name))
  const frozen = files.map(fileIdentity)
  assert.throws(() => freezeEvidence(f.root, { identity }), { code: 'EVIDENCE_CHANGED' })
  assert.deepEqual(files.map(fileIdentity), frozen)
  verifyFrozenEvidence(f.source, { identity })
})

for (const name of ['producer-completion.json', 'evidence-freeze.json']) test(`an existing ${name} is never replaced while finalizing`, { timeout: 10000 }, async t => {
  const f = fixture(t)
  await f.completedOwner()
  const file = path.join(f.source, name)
  fs.writeFileSync(file, 'previous evidence that must remain unchanged\n')
  const before = fileIdentity(file)
  assert.throws(() => freezeEvidence(f.root, { identity }), { code: name === 'evidence-freeze.json' ? 'EVIDENCE_CHANGED' : 'EEXIST' })
  assert.deepEqual(fileIdentity(file), before)
  if (name === 'producer-completion.json') assert.equal(fs.existsSync(path.join(f.source, 'evidence-freeze.json')), false)
  else assert.equal(fs.existsSync(path.join(f.source, 'producer-completion.json')), false)
})
