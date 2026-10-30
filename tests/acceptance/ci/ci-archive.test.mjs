import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { archiveCi, archiveSnapshotForUpload, verifyArchive } from '../../../scripts/acceptance/ci-archive.mjs'
import { freezeEvidence } from '../../../scripts/acceptance/lib/ci-evidence.mjs'

const helper = fileURLToPath(new URL('../../../scripts/acceptance/ci-archive.mjs', import.meta.url))
const evidenceModule = new URL('../../../scripts/acceptance/lib/ci-evidence.mjs', import.meta.url).href
const protocolFiles = ['evidence-owner.json', 'producer-completion.json', 'evidence-freeze.json']
const sha = value => createHash('sha256').update(value).digest('hex')
const posix = process.platform !== 'win32'
const context = { repository: 'example/source', ref: 'main', revision: 'a'.repeat(40), dirty: false }

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-archive-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const archiveRoot = path.join(base, 'archives'), runnerTemp = path.join(base, 'runner-temp')
  let checkout = path.join(base, 'checkout'), source = path.join(checkout, 'tests/acceptance/output/ci'), selectedIdentity, checkoutCount = 0
  fs.mkdirSync(source, { recursive: true })
  fs.mkdirSync(runnerTemp)
  const write = (relative, contents, mode = 0o644) => {
    const file = path.join(source, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, typeof contents === 'string' || Buffer.isBuffer(contents) ? contents : JSON.stringify(contents) + '\n')
    fs.chmodSync(file, mode)
    return file
  }
  write('context.json', context)
  const messages = []
  const options = { archiveRoot, runnerTemp, identity: { repository: 'example/controller', runId: '100', attempt: '1' }, log: message => messages.push(message) }
  const prepare = requested => {
    const key = JSON.stringify(requested)
    if (selectedIdentity && selectedIdentity !== key) {
      const previous = source
      checkout = path.join(base, `checkout-${++checkoutCount}`)
      source = path.join(checkout, 'tests/acceptance/output/ci')
      fs.mkdirSync(source, { recursive: true })
      fs.cpSync(previous, source, { recursive: true, verbatimSymlinks: true, filter: file => !protocolFiles.some(name => file === path.join(previous, name)) })
    }
    selectedIdentity = key
  }
  const freeze = (runId = '100', requested = { ...options.identity, runId }) => {
    prepare(requested)
    if (fs.existsSync(path.join(source, 'evidence-freeze.json'))) return
    const script = `import {createEvidenceScope,finishEvidenceScope} from ${JSON.stringify(evidenceModule)};const scope=createEvidenceScope(process.cwd(),${JSON.stringify(requested)});finishEvidenceScope(scope,{outcome:'failed',exitCode:1});process.exitCode=1;`
    const owner = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: checkout, env: { ...process.env, HALO_ACCEPTANCE_EVIDENCE_SCOPE: undefined }, encoding: 'utf8', timeout: 5000 })
    assert.equal(owner.status, 1, owner.stderr)
    assert.equal(owner.signal, null)
    freezeEvidence(checkout, { identity: requested })
  }
  const archive = (runId = '100', extra = {}) => {
    const { freeze: shouldFreeze = true, ...overrides } = extra
    const requested = overrides.identity ?? { ...options.identity, runId }
    prepare(requested)
    if (shouldFreeze) freeze(runId, requested)
    return archiveCi({ ...options, checkout, identity: requested, ...overrides })
  }
  return { base, get source() { return source }, get checkout() { return checkout }, archiveRoot, runnerTemp, write, messages, get options() { return { ...options, checkout } }, archive, freeze }
}

function snapshot(directory) {
  const entries = []
  const walk = folder => {
    for (const name of fs.readdirSync(folder).sort()) {
      const file = path.join(folder, name), value = fs.lstatSync(file)
      if (value.isDirectory()) walk(file)
      else entries.push([path.relative(directory, file), value.mode & 0o777, value.ino, value.mtimeMs, value.isFile() ? sha(fs.readFileSync(file)) : 'not-regular'])
    }
  }
  walk(directory)
  return entries
}

test('an installation failure retains initial context, hashes and original access restrictions without claiming a passing run', { skip: !posix }, t => {
  const f = fixture(t)
  f.write('summary.md', 'Installation failed before any test could execute.\n')
  f.write('install/log.txt', 'bounded preparation diagnostics', 0o600)
  fs.mkdirSync(path.join(f.source, 'empty'))
  f.freeze()
  const original = snapshot(f.source)
  const result = f.archive()
  const checked = verifyArchive(result.directory)
  assert.equal(checked.manifest.source.revision, context.revision)
  assert.equal(checked.manifest.testRun.present, false)
  assert.equal(result.testStatus, null)
  assert.equal(result.remoteUpload, 'not-observed')
  assert.equal(checked.manifest.remoteUpload.status, 'not-observed')
  assert.deepEqual(checked.manifest.directories, ['empty', 'install'])
  assert.equal(checked.manifest.fileCount, 6)
  assert.equal(checked.manifest.version, 2)
  assert.equal(checked.sourceFinality.state, 'frozen')
  for (const item of checked.manifest.files) {
    const copied = path.join(result.directory, 'ci', item.path)
    assert.deepEqual(fs.readFileSync(copied), fs.readFileSync(path.join(f.source, item.path)))
    assert.equal(item.sha256, sha(fs.readFileSync(copied)))
    assert.equal(fs.statSync(copied).mode & 0o777, fs.statSync(path.join(f.source, item.path)).mode & 0o640)
  }
  for (const folder of [f.archiveRoot, result.directory, path.join(result.directory, 'ci'), path.join(result.directory, 'ci/empty')]) assert.equal(fs.statSync(folder).mode & 0o777, 0o750)
  assert.deepEqual(snapshot(f.source), original)
  assert.equal(fs.existsSync(path.join(f.archiveRoot, '.archive.lock')), false)
})

test('failed test status and invalid integrity remain separate from a complete copy, and JSON references are never traversed', { skip: !posix }, t => {
  const f = fixture(t)
  const outside = path.join(f.base, 'private.txt')
  fs.writeFileSync(outside, 'never collect this file')
  const run = { id: 'run-example', status: 'incomplete', revision: { commit: context.revision }, catalogHash: 'b'.repeat(64), manifestHash: 'c'.repeat(64), evidenceIntegrity: { version: 1, valid: false, reasons: ['source changed'] }, attachment: outside }
  f.write('run/run.json', run, 0o600)
  const result = f.archive()
  const checked = verifyArchive(result.directory)
  assert.equal(result.testStatus, 'incomplete')
  assert.deepEqual(checked.manifest.testRun.evidenceIntegrity, { version: 1, valid: false, reasonCount: 1 })
  assert.equal(checked.manifest.source.catalogHash, run.catalogHash)
  assert.equal(checked.manifest.source.manifestHash, run.manifestHash)
  assert.deepEqual(fs.readFileSync(path.join(result.directory, 'ci/run/run.json')), fs.readFileSync(path.join(f.source, 'run/run.json')))
  assert.deepEqual(checked.manifest.files.map(item => item.path), ['context.json', ...protocolFiles, 'run/run.json'].sort())
  assert.equal(fs.readFileSync(outside, 'utf8'), 'never collect this file')
})

test('each controller run and attempt is exclusive, including pending copies', { skip: !posix }, t => {
  const f = fixture(t)
  const first = f.archive()
  const initial = snapshot(first.directory)
  assert.throws(() => f.archive(), { code: 'ARCHIVE_EXISTS' })
  assert.deepEqual(snapshot(first.directory), initial)
  const second = f.archive('100', { identity: { ...f.options.identity, attempt: '2' } })
  assert.notEqual(first.directory, second.directory)
  fs.unlinkSync(path.join(second.directory, 'COMPLETE.json'))
  const pending = snapshot(second.directory)
  assert.throws(() => f.archive('100', { identity: { ...f.options.identity, attempt: '2' } }), { code: 'ARCHIVE_EXISTS' })
  assert.deepEqual(snapshot(second.directory), pending)
})

test('unmanaged roots and roots overlapping checkout, workspace or runner temporary storage are refused', { skip: !posix }, t => {
  const f = fixture(t)
  fs.mkdirSync(f.archiveRoot, { mode: 0o750 })
  assert.throws(() => f.archive(), /not managed/)
  fs.writeFileSync(path.join(f.archiveRoot, 'unrelated.txt'), 'keep')
  assert.throws(() => f.archive(), /not managed/)
  assert.equal(fs.readFileSync(path.join(f.archiveRoot, 'unrelated.txt'), 'utf8'), 'keep')
  for (const archiveRoot of [path.join(f.checkout, 'archive'), path.join(f.runnerTemp, 'archive'), f.base]) assert.throws(() => f.archive('100', { archiveRoot }), /separate/)
  const workspace = path.join(f.base, 'workspace')
  fs.mkdirSync(workspace)
  assert.throws(() => f.archive('100', { workspace, archiveRoot: path.join(workspace, 'archive') }), /separate/)
})

test('source and destination links are rejected without following or modifying their targets', { skip: !posix }, t => {
  const f = fixture(t)
  const outside = path.join(f.base, 'outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'secret'), 'keep outside')
  for (const target of [outside, path.join(outside, 'secret')]) {
    const link = path.join(f.source, 'linked')
    fs.symlinkSync(target, link)
    assert.throws(() => f.archive('100', { freeze: false }), /links are not followed/)
    fs.unlinkSync(link)
  }
  const linkedParent = path.join(f.base, 'linked-parent')
  fs.symlinkSync(outside, linkedParent)
  assert.throws(() => f.archive('100', { archiveRoot: path.join(linkedParent, 'archives') }), /real directory/)
  fs.symlinkSync(outside, f.archiveRoot)
  assert.throws(() => f.archive(), /real directory/)
  assert.deepEqual(fs.readdirSync(outside), ['secret'])
  assert.equal(fs.readFileSync(path.join(outside, 'secret'), 'utf8'), 'keep outside')
})

test('a non-regular source entry fails before archival rather than being omitted', { skip: !posix }, async t => {
  const f = fixture(t)
  const server = net.createServer()
  // A short socket path also works on hosts with a small Unix-domain path limit.
  const socket = path.join(f.base, 's')
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  fs.renameSync(socket, path.join(f.source, 'socket'))
  assert.throws(() => f.archive('100', { freeze: false }), /non-regular/)
  assert.equal(fs.existsSync(f.archiveRoot), false)
})

test('mid-copy source mutation retains original evidence and pending output, and never prunes an older complete archive', { skip: !posix }, t => {
  const f = fixture(t)
  const first = f.archive('100', { keep: 1 })
  f.write('plan.json', 'not-json')
  let pending
  assert.throws(() => f.archive('101', { keep: 1, log: message => {
    if (message.includes('Metadata plan')) f.write('late.txt', 'new source evidence')
  } }), error => { pending = error.archiveDirectory; return /original evidence changed/.test(error.message) })
  assert.equal(fs.readFileSync(path.join(f.source, 'late.txt'), 'utf8'), 'new source evidence')
  assert.equal(fs.readFileSync(path.join(f.source, 'plan.json'), 'utf8'), 'not-json')
  assert.ok(pending)
  assert.equal(fs.existsSync(path.join(pending, 'COMPLETE.json')), false)
  assert.equal(verifyArchive(first.directory).manifest.identity.runId, '100')
  assert.throws(() => f.archive('101'), { code: 'ARCHIVE_EXISTS' })
  assert.equal(fs.existsSync(path.join(f.archiveRoot, '.archive.lock')), false)
})

for (const change of ['payload', 'manifest', 'permissions', 'extra', 'symlink']) {
  test(`verification refuses ${change} tampering`, { skip: !posix }, t => {
    const f = fixture(t), result = f.archive()
    const payload = path.join(result.directory, 'ci/context.json')
    if (change === 'payload') fs.appendFileSync(payload, 'altered')
    if (change === 'manifest') fs.appendFileSync(path.join(result.directory, 'manifest.json'), ' ')
    if (change === 'permissions') fs.chmodSync(payload, 0o644)
    if (change === 'extra') fs.writeFileSync(path.join(result.directory, 'unowned'), 'never delete')
    if (change === 'symlink') { fs.unlinkSync(payload); fs.symlinkSync(path.join(f.source, 'context.json'), payload) }
    assert.throws(() => verifyArchive(result.directory))
  })
}

test('offline verification derives final-source identity from copied freeze bytes rather than trusting matching metadata claims', { skip: !posix }, t => {
  const f = fixture(t), result = f.archive()
  const manifestFile = path.join(result.directory, 'manifest.json'), completeFile = path.join(result.directory, 'COMPLETE.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')), complete = JSON.parse(fs.readFileSync(completeFile, 'utf8'))
  manifest.sourceFinality.freezeSha256 = '0'.repeat(64)
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
  complete.freezeSha256 = manifest.sourceFinality.freezeSha256
  complete.manifestSha256 = sha(fs.readFileSync(manifestFile))
  fs.writeFileSync(completeFile, JSON.stringify(complete, null, 2) + '\n')
  assert.throws(() => verifyArchive(result.directory), /matching frozen evidence identity/)
})

test('a finalized archive remains verifiable after its original checkout and live producer metadata are gone', { skip: !posix }, t => {
  const f = fixture(t), result = f.archive()
  fs.rmSync(f.checkout, { recursive: true })
  const original = snapshot(result.directory)
  const verified = verifyArchive(result.directory)
  assert.equal(verified.sourceFinality.state, 'frozen')
  assert.deepEqual(snapshot(result.directory), original)
})

test('retention isolates controllers and preserves unknown, pending and tampered entries and the new archive', { skip: !posix }, t => {
  const f = fixture(t)
  const old = f.archive('100', { keep: 2 })
  const tampered = f.archive('101', { keep: 2 })
  fs.appendFileSync(path.join(tampered.directory, 'ci/context.json'), 'tampered')
  const pending = f.archive('102', { keep: 2 })
  fs.unlinkSync(path.join(pending.directory, 'COMPLETE.json'))
  fs.mkdirSync(path.join(f.archiveRoot, 'unknown'), { mode: 0o750 })
  fs.writeFileSync(path.join(f.archiveRoot, 'unknown/keep'), 'unrelated')
  const other = f.archive('103', { keep: 2, identity: { repository: 'another/controller', runId: '103', attempt: '1' } })
  const next = f.archive('104', { keep: 2 })
  assert.equal(verifyArchive(old.directory).manifest.identity.runId, '100')
  assert.deepEqual(next.retention.removed, [])
  assert.deepEqual(next.retention.otherControllerEntries, [path.basename(other.directory)])
  const current = f.archive('105', { keep: 2 })
  assert.equal(fs.existsSync(old.directory), false)
  assert.equal(verifyArchive(other.directory).manifest.identity.repository, 'another/controller')
  assert.equal(verifyArchive(current.directory).manifest.identity.runId, '105')
  assert.equal(verifyArchive(next.directory).manifest.identity.runId, '104')
  assert.equal(current.retention.controller, 'example/controller')
  assert.deepEqual(current.retention.otherControllerEntries, [path.basename(other.directory)])
  assert.equal(fs.existsSync(tampered.directory), true)
  assert.equal(fs.existsSync(pending.directory), true)
  assert.equal(fs.readFileSync(path.join(f.archiveRoot, 'unknown/keep'), 'utf8'), 'unrelated')
  assert.deepEqual(current.retention.protectedEntries.sort(), [path.basename(tampered.directory), path.basename(pending.directory), 'unknown'].sort())
  assert.equal(current.retention.removed.length, 1)
})

test('default retention keeps at most fourteen verified complete archives for its controller', { skip: !posix }, t => {
  const f = fixture(t), archives = []
  for (let id = 100; id < 115; id++) archives.push(f.archive(String(id)))
  assert.equal(fs.existsSync(archives[0].directory), false)
  assert.equal(archives.filter(item => fs.existsSync(item.directory)).length, 14)
  assert.equal(verifyArchive(archives.at(-1).directory).manifest.identity.runId, '114')
})

for (const unknown of ['a-unknown', 'z-unknown']) {
  test(`a new archive altered during retention scanning (${unknown}) cannot trigger deletion of older evidence`, { skip: !posix }, t => {
    const f = fixture(t)
    const old = f.archive('100', { keep: 1 })
    fs.mkdirSync(path.join(f.archiveRoot, unknown), { mode: 0o750 })
    let changed = false, damaged
    assert.throws(() => f.archive('101', { keep: 1, log: message => {
      if (!changed && message.includes(unknown)) {
        changed = true
        damaged = path.join(f.archiveRoot, fs.readdirSync(f.archiveRoot).find(name => name.startsWith('run-101-')))
        fs.appendFileSync(path.join(damaged, 'ci/context.json'), 'changed after copy')
      }
    } }), /changed size/)
    assert.equal(changed, true)
    assert.equal(verifyArchive(old.directory).manifest.identity.runId, '100')
    assert.equal(fs.existsSync(path.join(damaged, 'COMPLETE.json')), true)
    assert.throws(() => verifyArchive(damaged), /changed size/)
  })
}

test('a late source write during retention inspection cannot authorize deletion of older final evidence', { skip: !posix }, t => {
  const f = fixture(t), old = f.archive('100', { keep: 1 })
  fs.mkdirSync(path.join(f.archiveRoot, 'unknown'), { mode: 0o750 })
  let wrote = false
  assert.throws(() => f.archive('101', { keep: 1, log: message => {
    if (!wrote && message.includes('unknown')) {
      wrote = true
      f.write('summary.md', 'A summary written after the source was frozen.')
    }
  } }), { code: 'EVIDENCE_CHANGED' })
  assert.equal(wrote, true)
  assert.equal(verifyArchive(old.directory).manifest.identity.runId, '100')
  assert.equal(fs.readFileSync(path.join(f.source, 'summary.md'), 'utf8'), 'A summary written after the source was frozen.')
})

test('an entry replaced by a symlink before publication fails without writing into the replacement target', { skip: !posix }, t => {
  const f = fixture(t)
  f.write('plan.json', 'not-json')
  const outside = path.join(f.base, 'outside')
  fs.mkdirSync(outside)
  f.freeze()
  const before = snapshot(f.source)
  let replaced = false, rejected
  assert.throws(() => f.archive('100', { log: message => {
    if (message.includes('Metadata plan')) {
      const entry = path.join(f.archiveRoot, fs.readdirSync(f.archiveRoot).find(name => name.startsWith('run-100-')))
      fs.renameSync(entry, path.join(f.archiveRoot, 'pending-moved'))
      fs.symlinkSync(outside, entry)
      replaced = true
    }
  } }), error => { rejected = error; return /real directory/.test(error.message) })
  assert.equal(replaced, true)
  assert.deepEqual(fs.readdirSync(outside), [])
  assert.deepEqual(snapshot(f.source), before)
  assert.equal(fs.existsSync(path.join(f.archiveRoot, 'pending-moved/COMPLETE.json')), false)
  assert.equal(archiveSnapshotForUpload(rejected), null, 'a replaced entry must not be advertised to the artifact uploader')
})

test('the root lock prevents nested or abandoned writers without stealing their locks', { skip: !posix }, t => {
  const f = fixture(t)
  f.write('plan.json', 'malformed metadata')
  let locked = false
  f.archive('100', { log: message => {
    if (message.includes('Metadata plan')) {
      assert.throws(() => f.archive('101'), { code: 'ARCHIVE_LOCKED' })
      locked = true
    }
  } })
  assert.equal(locked, true)
  const lock = path.join(f.archiveRoot, '.archive.lock')
  fs.writeFileSync(lock, 'retained lock')
  assert.throws(() => f.archive('102'), { code: 'ARCHIVE_LOCKED' })
  assert.equal(fs.readFileSync(lock, 'utf8'), 'retained lock')
})

test('the dependency-free CLI reports its receipt and keeps upload observation separate on success and failure', { skip: !posix }, t => {
  const f = fixture(t)
  f.freeze('200')
  const summary = path.join(f.runnerTemp, 'summary'), output = path.join(f.runnerTemp, 'output')
  const env = { ...process.env, GITHUB_REPOSITORY: 'example/controller', GITHUB_RUN_ID: '200', GITHUB_RUN_ATTEMPT: '1', HALO_ACCEPTANCE_ARCHIVE_ROOT: f.archiveRoot, GITHUB_WORKSPACE: f.checkout, RUNNER_TEMP: f.runnerTemp, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output }
  const first = spawnSync(process.execPath, [helper], { cwd: f.checkout, env, encoding: 'utf8' })
  assert.equal(first.status, 0, first.stderr)
  const receipt = fs.readFileSync(output, 'utf8')
  assert.match(receipt, /archive-manifest-sha256=[a-f0-9]{64}/)
  assert.match(receipt, /snapshot-directory=/)
  assert.match(receipt, /source-final=true/)
  assert.match(fs.readFileSync(summary, 'utf8'), /Remote artifact upload has not been confirmed/)
  const directory = receipt.split('\n')[0].slice('archive-directory='.length)
  const verify = spawnSync(process.execPath, [helper, 'verify', directory], { encoding: 'utf8' })
  assert.equal(verify.status, 0, verify.stderr)
  assert.equal(JSON.parse(verify.stdout).copyVerified, true)
  assert.equal(JSON.parse(verify.stdout).sourceFinality.state, 'frozen')
  const repeatOutput = path.join(f.runnerTemp, 'repeat-output')
  const repeat = spawnSync(process.execPath, [helper], { cwd: f.checkout, env: { ...env, GITHUB_OUTPUT: repeatOutput }, encoding: 'utf8' })
  assert.equal(repeat.status, 1)
  assert.match(repeat.stderr, /ARCHIVE_EXISTS/)
  assert.equal(fs.existsSync(repeatOutput), false, 'an existing entry alone is not this invocation\'s ownership proof')
  assert.match(fs.readFileSync(summary, 'utf8'), /infrastructure archival outcome, not a product-test result/)
})

test('an unowned or unfinished input retains a non-final copy without completion, pruning or source changes', { skip: !posix }, t => {
  const older = fixture(t), first = older.archive('100', { keep: 1 })
  const f = fixture(t)
  f.write('stages.json', [{ stage: 'package preparation', status: 'running', exitCode: null }])
  const before = snapshot(f.source)
  let directory, rejected
  assert.throws(() => f.archive('101', { archiveRoot: older.archiveRoot, keep: 1, freeze: false }), error => { rejected = error; directory = error.archiveDirectory; return error.code === 'EVIDENCE_NOT_FROZEN' })
  assert.equal(fs.existsSync(path.join(directory, 'COMPLETE.json')), false)
  const incomplete = JSON.parse(fs.readFileSync(path.join(directory, 'INCOMPLETE.json'), 'utf8'))
  assert.equal(incomplete.kind, 'halo-acceptance-ci-incomplete')
  assert.equal(incomplete.reasonCode, 'EVIDENCE_NOT_FROZEN')
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
  assert.equal(manifest.sourceFinality.state, 'unconfirmed')
  assert.equal(incomplete.manifestSha256, sha(fs.readFileSync(path.join(directory, 'manifest.json'))))
  assert.throws(() => verifyArchive(directory), /pending|unexpected/)
  assert.deepEqual(snapshot(f.source), before)
  assert.equal(verifyArchive(first.directory).manifest.identity.runId, '100')
  assert.equal(fs.existsSync(path.join(older.archiveRoot, '.archive.lock')), false)
  assert.deepEqual(archiveSnapshotForUpload(rejected), { directory, sourceFinal: false })
  assert.equal(archiveSnapshotForUpload(Object.assign(new Error('forged'), { archiveDirectory: directory })), null)
  fs.appendFileSync(path.join(directory, 'ci/context.json'), 'changed after failure')
  assert.equal(archiveSnapshotForUpload(rejected), null, 'a once-safe failed copy must be checked again before upload')
})

test('a CLI failure publishes only its checked non-final snapshot path and keeps the stage failed', { skip: !posix }, t => {
  const f = fixture(t), output = path.join(f.runnerTemp, 'output')
  const result = spawnSync(process.execPath, [helper], { cwd: f.checkout, env: { ...process.env, GITHUB_REPOSITORY: 'example/controller', GITHUB_RUN_ID: '200', GITHUB_RUN_ATTEMPT: '1', HALO_ACCEPTANCE_ARCHIVE_ROOT: f.archiveRoot, GITHUB_WORKSPACE: f.checkout, RUNNER_TEMP: f.runnerTemp, GITHUB_OUTPUT: output }, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /EVIDENCE_NOT_FROZEN/)
  const receipt = fs.readFileSync(output, 'utf8')
  assert.match(receipt, /source-final=false/)
  assert.doesNotMatch(receipt, /archive-directory=|source-final=true/)
  const directory = receipt.split('\n').find(line => line.startsWith('snapshot-directory=')).slice('snapshot-directory='.length)
  assert.equal(path.dirname(directory), f.archiveRoot)
  assert.equal(fs.existsSync(path.join(directory, 'INCOMPLETE.json')), true)
  assert.equal(fs.existsSync(path.join(directory, 'COMPLETE.json')), false)
})

for (const changed of ['identity', 'payload']) {
  test(`a ${changed} mismatch after freezing cannot publish a final archive`, { skip: !posix }, t => {
    const f = fixture(t)
    f.freeze()
    let directory
    if (changed === 'payload') f.write('summary.md', 'A late summary must not silently extend the frozen payload.')
    const options = { ...f.options, ...(changed === 'identity' ? { identity: { ...f.options.identity, runId: '101' } } : {}) }
    assert.throws(() => archiveCi(options), error => { directory = error.archiveDirectory; return error.code === (changed === 'identity' ? 'EVIDENCE_IDENTITY_MISMATCH' : 'EVIDENCE_CHANGED') })
    assert.equal(fs.existsSync(path.join(directory, 'COMPLETE.json')), false)
    assert.equal(fs.existsSync(path.join(directory, 'INCOMPLETE.json')), true)
  })
}

async function waitingOwner(t, f, requested, { lateWrite = false } = {}) {
  const script = `import fs from 'node:fs';import path from 'node:path';import {createEvidenceScope,finishEvidenceScope} from ${JSON.stringify(evidenceModule)};const scope=createEvidenceScope(process.cwd(),${JSON.stringify(requested)});process.send('ready');process.on('message',()=>{${lateWrite ? "fs.writeFileSync(path.join(process.cwd(),'tests/acceptance/output/ci/late-stage.json'),JSON.stringify({stage:'package preparation',signal:'SIGKILL'}));" : ''}finishEvidenceScope(scope,{outcome:'cancelled',exitCode:1});process.exit(1);});`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: f.checkout, env: { ...process.env, HALO_ACCEPTANCE_EVIDENCE_SCOPE: undefined }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let errors = ''
  child.stdout.resume()
  child.stderr.on('data', chunk => { errors = (errors + String(chunk)).slice(-4096) })
  const closed = once(child, 'close')
  t.after(async () => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL'); await closed })
  await Promise.race([once(child, 'message'), closed.then(() => { throw new Error(`Synthetic evidence owner exited before readiness: ${errors}`) })])
  return { child, closed }
}

test('a quiet real writer cannot become final through a stable-copy interval, and its later tail does not rewrite that snapshot', { skip: !posix, timeout: 10000 }, async t => {
  const older = fixture(t), first = older.archive('100', { keep: 1 })
  const f = fixture(t), requested = { ...f.options.identity, runId: '101' }
  const { child, closed } = await waitingOwner(t, f, requested, { lateWrite: true })
  let directory
  assert.throws(() => archiveCi({ ...f.options, archiveRoot: older.archiveRoot, identity: requested, keep: 1 }), error => { directory = error.archiveDirectory; return error.code === 'EVIDENCE_UNSETTLED' })
  assert.equal(child.exitCode, null, 'archival must not terminate the writer')
  assert.equal(child.signalCode, null)
  process.kill(child.pid, 0)
  assert.equal(fs.existsSync(path.join(directory, 'COMPLETE.json')), false)
  assert.equal(fs.existsSync(path.join(directory, 'INCOMPLETE.json')), true)
  const captured = snapshot(directory)
  child.send('finish')
  await closed
  assert.equal(fs.existsSync(path.join(f.source, 'late-stage.json')), true)
  assert.equal(fs.existsSync(path.join(directory, 'ci/late-stage.json')), false)
  assert.deepEqual(snapshot(directory), captured)
  assert.equal(verifyArchive(first.directory).manifest.identity.runId, '100')
})

test('an owner killed before completion cannot obtain a freeze merely because its PID disappeared', { skip: !posix, timeout: 10000 }, async t => {
  const f = fixture(t), requested = f.options.identity
  const { child, closed } = await waitingOwner(t, f, requested)
  child.kill('SIGKILL')
  await closed
  assert.equal(child.signalCode, 'SIGKILL')
  assert.throws(() => freezeEvidence(f.checkout, { identity: requested }), { code: 'EVIDENCE_UNSETTLED' })
  let directory
  assert.throws(() => archiveCi(f.options), error => { directory = error.archiveDirectory; return error.code === 'EVIDENCE_UNSETTLED' })
  assert.equal(fs.existsSync(path.join(directory, 'COMPLETE.json')), false)
  assert.equal(fs.existsSync(path.join(directory, 'INCOMPLETE.json')), true)
})

test('legacy complete copies remain readable and unchanged but cannot enter final-evidence retention', { skip: !posix }, t => {
  const f = fixture(t), legacy = f.archive('100', { keep: 1 })
  const manifestFile = path.join(legacy.directory, 'manifest.json'), completionFile = path.join(legacy.directory, 'COMPLETE.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')), complete = JSON.parse(fs.readFileSync(completionFile, 'utf8'))
  manifest.version = 1
  delete manifest.sourceFinality
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
  complete.version = 1
  delete complete.freezeSha256
  complete.manifestSha256 = sha(fs.readFileSync(manifestFile))
  fs.writeFileSync(completionFile, JSON.stringify(complete, null, 2) + '\n')
  assert.equal(verifyArchive(legacy.directory).sourceFinality.state, 'legacy-unverified')
  const original = snapshot(legacy.directory)
  const next = f.archive('101', { keep: 1 })
  assert.deepEqual(next.retention.removed, [])
  assert(next.retention.protectedEntries.includes(path.basename(legacy.directory)))
  const current = f.archive('102', { keep: 1 })
  assert.deepEqual(current.retention.removed, [path.basename(next.directory)])
  assert.deepEqual(snapshot(legacy.directory), original)
  assert.equal(verifyArchive(current.directory).sourceFinality.state, 'frozen')
})

test('unsupported Windows archival fails explicitly before creating any archive', { skip: posix }, () => {
  assert.throws(() => archiveCi(), { code: 'ARCHIVE_UNSUPPORTED' })
})
