import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { archiveCi, verifyArchive } from '../../../scripts/acceptance/ci-archive.mjs'

const helper = fileURLToPath(new URL('../../../scripts/acceptance/ci-archive.mjs', import.meta.url))
const sha = value => createHash('sha256').update(value).digest('hex')
const posix = process.platform !== 'win32'
const context = { repository: 'example/source', ref: 'main', revision: 'a'.repeat(40), dirty: false }

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-archive-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const checkout = path.join(base, 'checkout'), archiveRoot = path.join(base, 'archives'), runnerTemp = path.join(base, 'runner-temp')
  const source = path.join(checkout, 'tests/acceptance/output/ci')
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
  const options = { checkout, archiveRoot, runnerTemp, identity: { repository: 'example/controller', runId: '100', attempt: '1' }, log: message => messages.push(message) }
  const archive = (runId = '100', extra = {}) => archiveCi({ ...options, identity: { ...options.identity, runId }, ...extra })
  return { base, source, checkout, archiveRoot, runnerTemp, write, messages, options, archive }
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
  const original = snapshot(f.source)
  const result = f.archive()
  const checked = verifyArchive(result.directory)
  assert.equal(checked.manifest.source.revision, context.revision)
  assert.equal(checked.manifest.testRun.present, false)
  assert.equal(result.testStatus, null)
  assert.equal(result.remoteUpload, 'not-observed')
  assert.equal(checked.manifest.remoteUpload.status, 'not-observed')
  assert.deepEqual(checked.manifest.directories, ['empty', 'install'])
  assert.equal(checked.manifest.fileCount, 3)
  for (const item of checked.manifest.files) {
    const copied = path.join(result.directory, 'ci', item.path)
    assert.deepEqual(fs.readFileSync(copied), fs.readFileSync(path.join(f.source, item.path)))
    assert.equal(item.sha256, sha(fs.readFileSync(copied)))
    assert.equal(fs.statSync(copied).mode & 0o777, item.path === 'install/log.txt' ? 0o600 : 0o640)
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
  assert.deepEqual(checked.manifest.files.map(item => item.path), ['context.json', 'run/run.json'])
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
    assert.throws(() => f.archive(), /links are not followed/)
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
  assert.throws(() => f.archive(), /non-regular/)
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

test('an entry replaced by a symlink before publication fails without writing into the replacement target', { skip: !posix }, t => {
  const f = fixture(t)
  f.write('plan.json', 'not-json')
  const outside = path.join(f.base, 'outside')
  fs.mkdirSync(outside)
  const before = snapshot(f.source)
  let replaced = false
  assert.throws(() => f.archive('100', { log: message => {
    if (message.includes('Metadata plan')) {
      const entry = path.join(f.archiveRoot, fs.readdirSync(f.archiveRoot).find(name => name.startsWith('run-100-')))
      fs.renameSync(entry, path.join(f.archiveRoot, 'pending-moved'))
      fs.symlinkSync(outside, entry)
      replaced = true
    }
  } }), /real directory/)
  assert.equal(replaced, true)
  assert.deepEqual(fs.readdirSync(outside), [])
  assert.deepEqual(snapshot(f.source), before)
  assert.equal(fs.existsSync(path.join(f.archiveRoot, 'pending-moved/COMPLETE.json')), false)
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
  const summary = path.join(f.runnerTemp, 'summary'), output = path.join(f.runnerTemp, 'output')
  const env = { ...process.env, GITHUB_REPOSITORY: 'example/controller', GITHUB_RUN_ID: '200', GITHUB_RUN_ATTEMPT: '1', HALO_ACCEPTANCE_ARCHIVE_ROOT: f.archiveRoot, GITHUB_WORKSPACE: f.checkout, RUNNER_TEMP: f.runnerTemp, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output }
  const first = spawnSync(process.execPath, [helper], { cwd: f.checkout, env, encoding: 'utf8' })
  assert.equal(first.status, 0, first.stderr)
  const receipt = fs.readFileSync(output, 'utf8')
  assert.match(receipt, /archive-manifest-sha256=[a-f0-9]{64}/)
  assert.match(fs.readFileSync(summary, 'utf8'), /Remote artifact upload has not been confirmed/)
  const directory = receipt.split('\n')[0].slice('archive-directory='.length)
  const verify = spawnSync(process.execPath, [helper, 'verify', directory], { encoding: 'utf8' })
  assert.equal(verify.status, 0, verify.stderr)
  assert.equal(JSON.parse(verify.stdout).copyVerified, true)
  const repeat = spawnSync(process.execPath, [helper], { cwd: f.checkout, env, encoding: 'utf8' })
  assert.equal(repeat.status, 1)
  assert.match(repeat.stderr, /ARCHIVE_EXISTS/)
  assert.match(fs.readFileSync(summary, 'utf8'), /infrastructure archival outcome, not a product-test result/)
})

test('unsupported Windows archival fails explicitly before creating any archive', { skip: posix }, () => {
  assert.throws(() => archiveCi(), { code: 'ARCHIVE_UNSUPPORTED' })
})
