import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

export const evidenceScopeVariable = 'HALO_ACCEPTANCE_EVIDENCE_SCOPE'
export const freezeFilename = 'evidence-freeze.json'
const ownerFilename = 'evidence-owner.json'
const completionFilename = 'producer-completion.json'
const payloadRelative = 'tests/acceptance/output/ci'
const controlRelative = 'tests/acceptance/output/ci-control'
const digest = value => createHash('sha256').update(value).digest('hex')
const now = () => new Date().toISOString()
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const within = (parent, child) => { const part = path.relative(parent, child); return part === '' || (!path.isAbsolute(part) && part !== '..' && !part.startsWith('..' + path.sep)) }
const posix = value => value.split(path.sep).join('/')

function fail(message, code = 'EVIDENCE_UNSETTLED') { throw Object.assign(new Error(message), { code }) }

function regularBytes(file, maximum = 8 * 1024 * 1024) {
  const before = fs.lstatSync(file)
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) fail('Evidence metadata must be a bounded regular file')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fs.fstatSync(fd)
    if (opened.dev !== before.dev || opened.ino !== before.ino) fail('Evidence metadata changed while opening')
    const bytes = fs.readFileSync(fd)
    const after = fs.fstatSync(fd)
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail('Evidence metadata changed while reading')
    return bytes
  } finally { fs.closeSync(fd) }
}

function json(file) { return JSON.parse(regularBytes(file).toString('utf8')) }

function realDirectory(directory) {
  const info = fs.lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) fail('Evidence directories must not be symbolic links')
  return fs.realpathSync(directory)
}

export function assertOwnedEvidencePath(root, file) {
  root = fs.realpathSync(root)
  if (!within(root, file)) fail('Evidence path leaves its checkout')
  let current = root
  for (const part of path.relative(root, file).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    let info
    try { info = fs.lstatSync(current) } catch (error) { if (error.code === 'ENOENT') break; throw error }
    if (info.isSymbolicLink()) fail('Evidence paths cannot traverse symbolic links')
  }
}

function atomicEvidence(file, bytes, { exclusive = false, mode = 0o600 } = {}) {
  const directory = realDirectory(path.dirname(file))
  if (path.dirname(file) !== directory) fail('Evidence metadata parent is not canonical')
  try { const existing = fs.lstatSync(file); if (!existing.isFile() || existing.isSymbolicLink()) fail('Evidence destinations must be regular files') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = path.join(directory, `.${path.basename(file)}-${randomUUID()}.tmp`)
  const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), mode)
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd) }
  finally { fs.closeSync(fd) }
  try {
    if (exclusive) { fs.linkSync(temporary, file); fs.unlinkSync(temporary) }
    else fs.renameSync(temporary, file)
    if (process.platform !== 'win32') {
      const parent = fs.openSync(directory, fs.constants.O_RDONLY)
      try { fs.fsyncSync(parent) } finally { fs.closeSync(parent) }
    }
  } catch (error) {
    try { fs.unlinkSync(temporary) } catch (cleanup) { if (cleanup.code !== 'ENOENT') throw new AggregateError([error, cleanup], 'Evidence metadata publication and cleanup failed') }
    throw error
  }
}

export function writeEvidenceJson(file, value, options) { atomicEvidence(file, JSON.stringify(value, null, 2) + '\n', options) }
export function writeEvidenceText(file, value, options) { atomicEvidence(file, value, options) }

function admission(scope, operation) {
  const lock = path.join(scope.directory, 'admission.lock')
  const deadline = performance.now() + 1000
  let fd
  while (fd === undefined) {
    try { fd = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (performance.now() >= deadline) fail('Evidence producer admission is still in progress; no completion can be asserted')
      // Acquisition, not elapsed time, establishes the registration/closure barrier.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
  const held = fs.fstatSync(fd)
  let result, operationError
  try {
    fs.writeFileSync(fd, JSON.stringify({ nonce: scope.nonce, pid: process.pid }))
    fs.fsyncSync(fd)
    result = operation()
  } catch (error) { operationError = error }
  try {
    fs.closeSync(fd)
    const current = fs.lstatSync(lock)
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== held.dev || current.ino !== held.ino) fail('Evidence admission lock changed identity; it was retained')
    fs.unlinkSync(lock)
  } catch (error) {
    if (operationError) throw new AggregateError([operationError, error], 'Evidence admission operation and lock cleanup failed')
    throw error
  }
  if (operationError) throw operationError
  return result
}

function identity(value) {
  if (!value || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository ?? '') || !/^[A-Za-z0-9_-]{1,128}$/.test(String(value.runId ?? '')) || !/^\d+$/.test(String(value.attempt ?? ''))) fail('Evidence requires a valid run identity', 'EVIDENCE_IDENTITY_MISMATCH')
  return { repository: value.repository.toLowerCase(), runId: String(value.runId), attempt: String(value.attempt) }
}

function checkIdentity(actual, expected) {
  const value = identity(actual)
  if (expected && !same(value, identity(expected))) fail('Evidence belongs to another run or attempt', 'EVIDENCE_IDENTITY_MISMATCH')
  return value
}

function scopeAt(root, filename) {
  root = fs.realpathSync(root)
  const control = path.join(root, controlRelative)
  if (!path.isAbsolute(filename) || !within(control, filename) || path.basename(filename) !== 'scope.json' || fs.realpathSync(filename) !== filename) fail('Evidence scope leaves its owned checkout')
  const value = json(filename)
  if (value.version !== 1 || value.kind !== 'halo-acceptance-evidence-scope' || value.root !== root || !/^[a-f0-9-]{36}$/.test(value.nonce ?? '')) fail('Unsupported evidence producer scope')
  checkIdentity(value.identity)
  if (!/^[a-f0-9]{40}$/.test(value.revision ?? '')) fail('Evidence scope has no fixed source revision')
  return { ...value, path: filename, directory: path.dirname(filename) }
}

export function evidenceScope(root, environment = process.env) {
  const filename = environment[evidenceScopeVariable]
  return filename ? scopeAt(root, filename) : null
}

function pointerScope(root) {
  root = fs.realpathSync(root)
  assertOwnedEvidencePath(root, path.join(root, payloadRelative, ownerFilename))
  let pointer
  try { pointer = json(path.join(root, payloadRelative, ownerFilename)) }
  catch (error) { if (error.code === 'ENOENT') fail('No CI evidence owner was recorded', 'EVIDENCE_NOT_FROZEN'); throw error }
  if (typeof pointer.scope !== 'string' || path.isAbsolute(pointer.scope) || pointer.scope.includes('\\') || pointer.scope.split('/').some(part => !part || part === '.' || part === '..')) fail('Invalid evidence owner pointer')
  const scope = scopeAt(root, path.join(root, pointer.scope))
  if (scope.nonce !== pointer.nonce || !same(scope.identity, pointer.identity)) fail('Evidence owner pointer changed', 'EVIDENCE_IDENTITY_MISMATCH')
  return scope
}

export function createEvidenceScope(root, requested) {
  root = fs.realpathSync(root)
  assertOwnedEvidencePath(root, path.join(root, payloadRelative))
  const payload = realDirectory(path.join(root, payloadRelative))
  if (!within(root, payload)) fail('CI evidence leaves the checkout')
  const context = json(path.join(payload, 'context.json'))
  if (!/^[a-f0-9]{40}$/.test(context.revision ?? '')) fail('Initial CI context must contain a fixed source revision')
  const nonce = randomUUID()
  const control = path.join(root, controlRelative)
  assertOwnedEvidencePath(root, control)
  fs.mkdirSync(control, { recursive: true, mode: 0o700 })
  if (!within(root, realDirectory(control))) fail('Evidence control directory leaves the checkout')
  const directory = path.join(control, nonce)
  fs.mkdirSync(directory, { mode: 0o700 })
  fs.mkdirSync(path.join(directory, 'producers'), { mode: 0o700 })
  const value = { version: 1, kind: 'halo-acceptance-evidence-scope', root, nonce, identity: identity(requested), revision: context.revision, contextHash: digest(regularBytes(path.join(payload, 'context.json'))), createdAt: now() }
  const filename = path.join(directory, 'scope.json')
  writeEvidenceJson(filename, value, { exclusive: true })
  writeEvidenceJson(path.join(directory, 'owner.json'), { version: 1, nonce, pid: process.pid, state: 'running', startedAt: now() }, { exclusive: true })
  writeEvidenceJson(path.join(payload, ownerFilename), { version: 1, nonce, identity: value.identity, scope: posix(path.relative(root, filename)) }, { exclusive: true, mode: 0o640 })
  return { ...value, path: filename, directory }
}

export function beginEvidenceProducer(root, role, { environment = process.env, self = false, evidencePaths = [] } = {}) {
  const scope = evidenceScope(root, environment)
  if (!scope) return null
  if (typeof role !== 'string' || !/^[a-zA-Z0-9 .:_-]{1,100}$/.test(role)) fail('Invalid evidence producer role')
  const files = evidencePaths.map(file => {
    const absolute = path.resolve(file)
    if (!within(path.join(scope.root, 'tests/acceptance/output'), absolute) || within(path.join(scope.root, controlRelative), absolute)) fail('An evidence producer declares an output outside its managed output area')
    return posix(path.relative(scope.root, absolute))
  })
  return admission(scope, () => {
    const owner = json(path.join(scope.directory, 'owner.json'))
    if (owner.nonce !== scope.nonce || owner.state !== 'running' || absent(owner.pid)) fail('The CI owner is no longer accepting evidence producers')
    const id = randomUUID(), filename = path.join(scope.directory, 'producers', id + '.json')
    const record = { version: 1, id, nonce: scope.nonce, role, self, evidencePaths: files, state: self ? 'running' : 'starting', pid: self ? process.pid : null, group: false, createdAt: now() }
    writeEvidenceJson(filename, record, { exclusive: true })
    return { scope, filename, record }
  })
}

export function startEvidenceProducer(producer, pid, { group = false } = {}) {
  if (!producer) return
  if (json(producer.filename).state !== 'starting') fail('An evidence producer cannot restart its recorded lifetime')
  if (!Number.isSafeInteger(pid) || pid <= 1) fail('Evidence producer has no safe process identity')
  producer.record = { ...producer.record, state: 'running', pid, group }
  writeEvidenceJson(producer.filename, producer.record)
}

export function finishEvidenceProducer(producer, { exitCode = null, signal = null, cleanupConfirmed = true } = {}) {
  if (!producer) return
  if (json(producer.filename).state === 'closed') fail('An evidence producer completion is immutable')
  producer.record = { ...producer.record, state: cleanupConfirmed ? 'closed' : 'unknown', exitCode, signal, cleanupConfirmed, finishedAt: now() }
  writeEvidenceJson(producer.filename, producer.record)
  if (!producer.record.self && cleanupConfirmed && producer.record.pid) {
    for (const name of fs.readdirSync(path.join(producer.scope.directory, 'producers'))) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue
      const file = path.join(producer.scope.directory, 'producers', name)
      const record = json(file)
      if (record.self && record.pid === producer.record.pid && record.nonce === producer.scope.nonce) writeEvidenceJson(file, { ...record, state: 'closed', cleanupConfirmed: true, observedExitCode: exitCode, observedSignal: signal, finishedAt: record.finishedAt ?? now(), processClosedAt: now() })
    }
  }
}

export function rejectEvidenceSpawn(producer, errorCode = 'UNAVAILABLE') {
  if (!producer) return
  producer.record = { ...producer.record, state: 'closed', neverStarted: true, cleanupConfirmed: true, errorCode: /^[A-Z0-9_]{1,60}$/.test(errorCode) ? errorCode : 'UNAVAILABLE', finishedAt: now() }
  writeEvidenceJson(producer.filename, producer.record)
}

export function cancelEvidenceScope(scope, signal) {
  return admission(scope, () => {
    const owner = json(path.join(scope.directory, 'owner.json'))
    if (owner.pid !== process.pid || owner.nonce !== scope.nonce) fail('Only the original CI owner may cancel its evidence scope')
    if (owner.state === 'running') writeEvidenceJson(path.join(scope.directory, 'owner.json'), { ...owner, state: 'cancelling', interruptedAt: now(), interruptSignal: signal })
  })
}

export function finishEvidenceScope(scope, { outcome, exitCode = null, signal = null } = {}) {
  if (!['passed', 'failed', 'cancelled'].includes(outcome)) fail('The CI owner must retain an explicit terminal outcome')
  return admission(scope, () => {
    const owner = json(path.join(scope.directory, 'owner.json'))
    if (owner.pid !== process.pid || owner.nonce !== scope.nonce) fail('Only the original CI owner may finish its evidence scope')
    if (!['running', 'cancelling'].includes(owner.state)) fail('The CI owner terminal state is immutable')
    if (owner.state === 'cancelling' && outcome !== 'cancelled') fail('A cancelled CI owner cannot become a passing or failed normal run')
    writeEvidenceJson(path.join(scope.directory, 'owner.json'), { ...owner, state: 'finished', outcome, exitCode, signal, finishedAt: now() })
  })
}

function absent(pid, group = false) {
  if (!Number.isSafeInteger(pid) || pid <= 1) fail('A producer process identity is unknown')
  try { process.kill(group ? -pid : pid, 0); return false }
  catch (error) { if (error.code === 'ESRCH') return true; fail('A producer process exit cannot be confirmed') }
}

export function stoppedEvidenceProducers(root, { identity: requested } = {}) {
  const scope = pointerScope(root)
  checkIdentity(scope.identity, requested)
  if (fs.existsSync(path.join(scope.directory, 'admission.lock'))) fail('Evidence registration or owner closure has not finished')
  const owner = json(path.join(scope.directory, 'owner.json'))
  if (owner.nonce !== scope.nonce || owner.state !== 'finished' || !['passed', 'failed', 'cancelled'].includes(owner.outcome) || !absent(owner.pid)) fail('The CI evidence owner has not completed and exited')
  const producers = fs.readdirSync(path.join(scope.directory, 'producers')).sort().map(name => {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) fail('Unrecognized evidence producer record')
    const value = json(path.join(scope.directory, 'producers', name))
    if (value.version !== 1 || value.id + '.json' !== name || typeof value.self !== 'boolean' || !Array.isArray(value.evidencePaths) || value.evidencePaths.length > 100) fail('Invalid evidence producer record')
    return value
  })
  for (const producer of producers) {
    if (producer.nonce !== scope.nonce || producer.state !== 'closed' || producer.cleanupConfirmed !== true) fail('An evidence producer has not confirmed process and output completion')
    if (producer.neverStarted === true && producer.pid === null && producer.self === false) continue
    if (!absent(producer.pid) || (producer.group && process.platform !== 'win32' && !absent(producer.pid, true))) fail('An evidence producer process is still present')
  }
  const payload = path.join(scope.root, payloadRelative)
  if (digest(regularBytes(path.join(payload, 'context.json'))) !== scope.contextHash) fail('The captured CI context changed', 'EVIDENCE_CHANGED')
  return { scope, owner, producers }
}

function inventory(directory) {
  const root = realDirectory(directory), files = [], directories = []
  function visit(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(folder, entry.name), name = posix(path.relative(root, file))
      if (name === freezeFilename) continue
      const before = fs.lstatSync(file)
      if (before.isSymbolicLink()) fail('Evidence payload links cannot be frozen', 'EVIDENCE_CHANGED')
      if (before.isDirectory()) { directories.push(name); visit(file); continue }
      if (!before.isFile()) fail('Evidence payload must contain regular files', 'EVIDENCE_CHANGED')
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
      try {
        const stat = fs.fstatSync(fd)
        if (stat.dev !== before.dev || stat.ino !== before.ino) fail('Evidence file identity changed', 'EVIDENCE_CHANGED')
        const hash = createHash('sha256'), buffer = Buffer.alloc(128 * 1024)
        let bytes = 0, size
        while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) { hash.update(buffer.subarray(0, size)); bytes += size }
        const after = fs.fstatSync(fd)
        if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail('Evidence changed while hashing', 'EVIDENCE_CHANGED')
        files.push({ path: name, bytes, sha256: hash.digest('hex') })
      } finally { fs.closeSync(fd) }
    }
  }
  visit(root)
  return { files, directories, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0) }
}

export function freezeEvidence(root, { identity: requested } = {}) {
  const state = stoppedEvidenceProducers(root, { identity: requested })
  const directory = path.join(state.scope.root, payloadRelative)
  if (fs.existsSync(path.join(directory, freezeFilename))) fail('Frozen evidence cannot be rewritten', 'EVIDENCE_CHANGED')
  const completion = { version: 1, kind: 'halo-acceptance-producer-completion', identity: state.scope.identity, revision: state.scope.revision, nonce: state.scope.nonce, confirmedStopped: true, owner: state.owner, producers: state.producers }
  writeEvidenceJson(path.join(directory, completionFilename), completion, { exclusive: true, mode: 0o640 })
  const payload = inventory(directory)
  stoppedEvidenceProducers(root, { identity: requested })
  if (!same(payload, inventory(directory))) fail('Evidence changed before freezing', 'EVIDENCE_CHANGED')
  const receipt = { version: 1, kind: 'halo-acceptance-evidence-freeze', identity: state.scope.identity, revision: state.scope.revision, frozenAt: now(), completion: { outcome: state.owner.outcome, producerCount: state.producers.length }, payload }
  writeEvidenceJson(path.join(directory, freezeFilename), receipt, { exclusive: true, mode: 0o640 })
  return verifyFrozenEvidence(directory, { identity: requested })
}

export function verifyFrozenEvidence(directory, { identity: requested } = {}) {
  let bytes
  try { bytes = regularBytes(path.join(directory, freezeFilename), 32 * 1024 * 1024) }
  catch (error) { if (error.code === 'ENOENT') fail('CI evidence has no final freeze confirmation', 'EVIDENCE_NOT_FROZEN'); throw error }
  const receipt = JSON.parse(bytes.toString('utf8'))
  if (receipt.version !== 1 || receipt.kind !== 'halo-acceptance-evidence-freeze' || !/^[a-f0-9]{40}$/.test(receipt.revision ?? '') || !Number.isFinite(Date.parse(receipt.frozenAt))) fail('Unsupported evidence freeze confirmation', 'EVIDENCE_NOT_FROZEN')
  checkIdentity(receipt.identity, requested)
  const completion = json(path.join(directory, completionFilename))
  const context = json(path.join(directory, 'context.json'))
  if (completion.kind !== 'halo-acceptance-producer-completion' || completion.confirmedStopped !== true || completion.revision !== receipt.revision || context.revision !== receipt.revision || !same(completion.identity, receipt.identity) || completion.owner?.state !== 'finished' || !['passed', 'failed', 'cancelled'].includes(completion.owner?.outcome) || !Array.isArray(completion.producers) || completion.producers.some(value => value.state !== 'closed' || value.cleanupConfirmed !== true) || receipt.completion?.outcome !== completion.owner.outcome || receipt.completion?.producerCount !== completion.producers.length) fail('Evidence freeze lacks completed producer proof', 'EVIDENCE_NOT_FROZEN')
  if (!same(receipt.payload, inventory(directory))) fail('Evidence payload changed after freezing', 'EVIDENCE_CHANGED')
  const document = name => {
    const record = receipt.payload.files.find(file => file.path === name)
    if (!record) return null
    const body = regularBytes(path.join(directory, name), 32 * 1024 * 1024)
    if (body.length !== record.bytes || digest(body) !== record.sha256) fail('A frozen evidence document changed while reading', 'EVIDENCE_CHANGED')
    return JSON.parse(body.toString('utf8'))
  }
  return { freezeSha256: digest(bytes), receipt, documents: { context: document('context.json'), run: document('run/run.json') } }
}

export function verifyEvidenceSource(root, options = {}) {
  stoppedEvidenceProducers(root, options)
  return verifyFrozenEvidence(path.join(fs.realpathSync(root), payloadRelative), options)
}

export function assertEvidenceOutputWritable(root, file, environment = process.env) {
  if (!file) return
  root = fs.realpathSync(root)
  const directory = path.join(root, payloadRelative)
  const target = path.resolve(file)
  const inPayload = within(directory, target)
  if (!inPayload && !environment[evidenceScopeVariable]) return
  if (!within(path.join(root, 'tests/acceptance/output'), target)) fail('Scoped evidence writes must stay in their managed output area')
  assertOwnedEvidencePath(root, target)
  if (!inPayload) return
  if (fs.existsSync(path.join(directory, freezeFilename))) fail('Frozen CI evidence is read-only; use a new output directory', 'EVIDENCE_CHANGED')
  if (!fs.existsSync(path.join(directory, ownerFilename))) return
  const scope = evidenceScope(root, environment)
  if (!scope || scope.nonce !== pointerScope(root).nonce) fail('CI evidence writes require their recorded owner scope')
}
