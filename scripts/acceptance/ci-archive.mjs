import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { verifyEvidenceSource, verifyFrozenEvidence } from './lib/ci-evidence.mjs'

const rootMarker = '.acceptance-archive-root.json'
const lockName = '.archive.lock'
const creationName = 'archive.json'
const manifestName = 'manifest.json'
const completionName = 'COMPLETE.json'
const incompleteName = 'INCOMPLETE.json'
const completionTemporary = '.completion.pending'
const failedSnapshots = new WeakMap()
const sourceRelative = 'tests/acceptance/output/ci'
const noFollow = fs.constants.O_NOFOLLOW ?? 0
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const inside = (parent, child) => {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
const stamp = value => value ? [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs, value.mode, value.uid].map(String).join(':') : 'absent'
const identity = value => [value.dev, value.ino, value.mode, value.uid].map(String).join(':')
const stat = file => {
  try { return fs.lstatSync(file, { bigint: true }) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
const mode = value => Number(value.mode & 0o777n)

function fail(message, code = 'ARCHIVE_INVALID') {
  throw Object.assign(new Error(message), { code })
}

function owner() {
  if (process.platform === 'win32' || typeof process.getuid !== 'function' || !noFollow) {
    fail('Local archive stage unsupported: POSIX ownership, modes and no-follow opens are required; Windows ACL archival is not implemented.', 'ARCHIVE_UNSUPPORTED')
  }
  return process.getuid()
}

function realDirectory(directory, expected) {
  const value = stat(directory)
  if (!value?.isDirectory() || value.isSymbolicLink()) fail(`A real directory is required: ${directory}`)
  if (expected && identity(value) !== identity(expected)) fail(`An owned directory changed during archival: ${directory}`)
  return value
}

function directoryParents(directory, missingLeaf = false) {
  const absolute = path.resolve(directory)
  const parsed = path.parse(absolute)
  let current = parsed.root
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part)
    if (!stat(current) && missingLeaf && index === parts.length - 1) return
    realDirectory(current)
  }
}

function managedDirectory(directory, uid, expected) {
  const value = realDirectory(directory, expected)
  if (Number(value.uid) !== uid || mode(value) !== 0o750) fail(`Managed archive directories must belong to this account and have mode 0750: ${directory}`)
  return value
}

function synchronizeDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | noFollow | (fs.constants.O_DIRECTORY ?? 0))
  try {
    if (!fs.fstatSync(fd).isDirectory()) fail('A directory changed before its metadata could be synchronized.')
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
}

function newDirectory(directory) {
  fs.mkdirSync(directory, { mode: 0o750 })
  const created = realDirectory(directory)
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | noFollow | (fs.constants.O_DIRECTORY ?? 0))
  let ready
  try {
    if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(created)) fail('A newly created directory changed before its permissions were set.')
    fs.fchmodSync(fd, 0o750)
    fs.fsyncSync(fd)
    ready = fs.fstatSync(fd, { bigint: true })
    realDirectory(directory, ready)
  } finally { fs.closeSync(fd) }
  synchronizeDirectory(path.dirname(directory))
  return ready
}

function readRegular(file, maximum = Infinity) {
  const before = stat(file)
  if (!before?.isFile() || before.isSymbolicLink()) fail(`A regular file is required: ${file}`)
  if (before.size > BigInt(Number.MAX_SAFE_INTEGER) || Number(before.size) > maximum) fail(`Metadata is too large to inspect safely: ${file}`)
  const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow)
  try {
    if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(before)) fail(`A file changed before it could be inspected: ${file}`)
    const bytes = fs.readFileSync(fd)
    if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(before) || stamp(stat(file)) !== stamp(before)) fail(`A file changed while being inspected: ${file}`)
    return bytes
  } finally { fs.closeSync(fd) }
}

function newJson(file, value, permissions = 0o640) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n')
    fs.fchmodSync(fd, permissions)
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
}

function readJson(file) {
  const bytes = readRegular(file, 64 * 1024 * 1024)
  try { return JSON.parse(bytes.toString('utf8')) }
  catch { fail(`Managed record is not valid JSON: ${path.basename(file)}`) }
}

function validRelative(value) {
  return typeof value === 'string' && value && !value.includes('\\') && !path.isAbsolute(value) && !/^[a-z]:/i.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..')
}

function requestIdentity(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value?.repository ?? '')) fail('The archive requires its controller owner/repository.')
  for (const key of ['runId', 'attempt']) if (!/^[1-9]\d{0,19}$/.test(String(value[key] ?? ''))) fail(`The archive requires a positive numeric ${key}.`)
  return { repository: value.repository.toLowerCase(), runId: String(value.runId), attempt: String(value.attempt) }
}

function entryName(value) {
  return `run-${value.runId}-attempt-${value.attempt}-${digest(value.repository).slice(0, 16)}`
}

function loadRoot(directory, uid) {
  directoryParents(directory)
  const directoryStat = managedDirectory(directory, uid)
  const markerFile = path.join(directory, rootMarker)
  const markerStat = stat(markerFile)
  if (!markerStat?.isFile() || Number(markerStat.uid) !== uid || mode(markerStat) !== 0o640) fail('The existing archive root is not managed by this account.')
  const marker = readJson(markerFile)
  if (marker.kind !== 'halo-acceptance-archive-root' || marker.version !== 1 || marker.owner !== uid || !/^[a-f0-9-]{36}$/.test(marker.rootId ?? '')) fail('The existing archive root has no supported management marker.')
  return { directory, uid, marker, directoryStat }
}

function prepareRoot(directory, forbidden, uid) {
  if (!path.isAbsolute(directory) || /[\0\r\n]/.test(directory)) fail('The archive root must be a one-line absolute directory path.')
  directory = path.resolve(directory)
  directoryParents(directory, true)
  for (const location of forbidden.filter(Boolean)) {
    const resolved = stat(location) ? fs.realpathSync(location) : path.resolve(location)
    if (inside(resolved, directory) || inside(directory, resolved)) fail('The archive root must be separate from the checkout, workspace and runner temporary directory.')
  }
  if (!stat(directory)) {
    newDirectory(directory)
    newJson(path.join(directory, rootMarker), { kind: 'halo-acceptance-archive-root', version: 1, rootId: randomUUID(), owner: uid, createdAt: new Date().toISOString() })
    synchronizeDirectory(directory)
  }
  return loadRoot(directory, uid)
}

function lockRoot(root) {
  managedDirectory(root.directory, root.uid, root.directoryStat)
  const file = path.join(root.directory, lockName)
  try { newJson(file, { kind: 'halo-acceptance-archive-lock', version: 1, rootId: root.marker.rootId, pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() }, 0o600) }
  catch (error) {
    if (error.code === 'EEXIST') fail('The archive root is locked. Confirm the owning archival process has exited before resolving a retained lock.', 'ARCHIVE_LOCKED')
    throw error
  }
  const locked = stat(file)
  synchronizeDirectory(root.directory)
  return () => {
    managedDirectory(root.directory, root.uid, root.directoryStat)
    const current = stat(file)
    if (!current || stamp(current) !== stamp(locked)) fail('The archive lock changed; it was not removed.')
    fs.unlinkSync(file)
    synchronizeDirectory(root.directory)
  }
}

function inventory(directory) {
  const directories = [], files = []
  const walk = (folder, relative) => {
    const before = realDirectory(folder)
    directories.push({ path: relative, stat: before })
    for (const name of fs.readdirSync(folder).sort()) {
      const location = relative ? `${relative}/${name}` : name
      if (!validRelative(location)) fail(`Unsupported evidence filename: ${JSON.stringify(location)}`)
      const file = path.join(folder, name)
      const value = stat(file)
      if (value?.isSymbolicLink()) fail(`Evidence links are not followed: ${JSON.stringify(location)}`)
      if (value?.isDirectory()) walk(file, location)
      else if (value?.isFile()) files.push({ path: location, stat: value })
      else fail(`Evidence contains a non-regular entry: ${JSON.stringify(location)}`)
    }
    if (stamp(realDirectory(folder)) !== stamp(before)) fail(`An evidence directory changed during inspection: ${JSON.stringify(relative)}`)
  }
  walk(directory, '')
  const signature = JSON.stringify([...directories.map(item => ['directory', item.path, stamp(item.stat)]), ...files.map(item => ['file', item.path, stamp(item.stat)])])
  return { directories, files, signature }
}

function assertParents(directory, relative, records, owned) {
  const parts = relative.split('/')
  for (let length = 0; length < parts.length; length++) {
    const name = parts.slice(0, length).join('/')
    const expected = records.get(name)
    if (!expected) fail('A copied file has an unknown parent directory.')
    const folder = name ? path.join(directory, name) : directory
    if (owned) managedDirectory(folder, owned.uid, expected)
    else if (stamp(realDirectory(folder)) !== stamp(expected)) fail(`An evidence parent changed: ${JSON.stringify(name)}`)
  }
}

function copyFile(source, destination, record, sourceDirectories, destinationDirectories, root, archive, archiveStat) {
  managedDirectory(root.directory, root.uid, root.directoryStat)
  managedDirectory(archive, root.uid, archiveStat)
  assertParents(source, record.path, sourceDirectories)
  assertParents(destination, record.path, destinationDirectories, root)
  const input = path.join(source, record.path), output = path.join(destination, record.path)
  const read = fs.openSync(input, fs.constants.O_RDONLY | noFollow)
  let write
  try {
    if (stamp(fs.fstatSync(read, { bigint: true })) !== stamp(record.stat)) fail(`Evidence changed before copying: ${JSON.stringify(record.path)}`)
    assertParents(source, record.path, sourceDirectories)
    write = fs.openSync(output, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600)
    assertParents(destination, record.path, destinationDirectories, root)
    const checksum = createHash('sha256'), buffer = Buffer.allocUnsafe(128 * 1024)
    let bytes = 0
    for (;;) {
      const count = fs.readSync(read, buffer, 0, buffer.length, null)
      if (!count) break
      checksum.update(buffer.subarray(0, count))
      for (let offset = 0; offset < count;) offset += fs.writeSync(write, buffer, offset, count - offset)
      bytes += count
    }
    if (stamp(fs.fstatSync(read, { bigint: true })) !== stamp(record.stat) || stamp(stat(input)) !== stamp(record.stat)) fail(`Evidence changed while copying: ${JSON.stringify(record.path)}`)
    const permissions = mode(record.stat) & 0o640
    fs.fchmodSync(write, permissions)
    fs.fsyncSync(write)
    assertParents(destination, record.path, destinationDirectories, root)
    synchronizeDirectory(path.dirname(output))
    return { path: record.path, bytes, sha256: checksum.digest('hex'), mode: permissions, sourceMode: mode(record.stat) }
  } finally {
    fs.closeSync(read)
    if (write !== undefined) fs.closeSync(write)
  }
}

function hashFile(file, expected) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow)
  try {
    if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(expected)) fail('An archive file changed before verification.')
    const checksum = createHash('sha256'), buffer = Buffer.allocUnsafe(128 * 1024)
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (!count) break
      checksum.update(buffer.subarray(0, count))
    }
    if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(expected) || stamp(stat(file)) !== stamp(expected)) fail('An archive file changed during verification.')
    return checksum.digest('hex')
  } finally { fs.closeSync(fd) }
}

function verifyPayload(directory, manifest, uid) {
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.directories)) fail('The archive manifest has no supported file inventory.')
  const files = new Map()
  for (const record of manifest.files) {
    if (!validRelative(record.path) || files.has(record.path) || !/^[a-f0-9]{64}$/.test(record.sha256 ?? '') || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || !Number.isInteger(record.mode) || (record.mode & ~0o640)) fail('The archive manifest has an invalid file entry.')
    files.set(record.path, record)
  }
  if (manifest.directories.some(name => !validRelative(name)) || new Set(manifest.directories).size !== manifest.directories.length) fail('The archive manifest has an invalid directory entry.')
  const tree = inventory(path.join(directory, 'ci'))
  const parents = new Map(tree.directories.map(item => [item.path, item.stat]))
  if (JSON.stringify(tree.directories.map(item => item.path).filter(Boolean).sort()) !== JSON.stringify([...manifest.directories].sort()) || JSON.stringify(tree.files.map(item => item.path).sort()) !== JSON.stringify([...files.keys()].sort())) fail('The archive payload no longer matches its complete inventory.')
  for (const item of tree.directories) if (Number(item.stat.uid) !== uid || mode(item.stat) !== 0o750) fail('An archive directory has changed ownership or permissions.')
  let totalBytes = 0
  for (const item of tree.files) {
    const record = files.get(item.path)
    if (Number(item.stat.uid) !== uid || mode(item.stat) !== record.mode || item.stat.size !== BigInt(record.bytes)) fail(`An archive file has changed size, ownership or permissions: ${JSON.stringify(item.path)}`)
    assertParents(path.join(directory, 'ci'), item.path, parents)
    if (hashFile(path.join(directory, 'ci', item.path), item.stat) !== record.sha256) fail(`An archive file failed SHA-256 verification: ${JSON.stringify(item.path)}`)
    assertParents(path.join(directory, 'ci'), item.path, parents)
    totalBytes += record.bytes
  }
  if (inventory(path.join(directory, 'ci')).signature !== tree.signature) fail('The archive payload changed during verification.')
  if (manifest.fileCount !== tree.files.length || manifest.totalBytes !== totalBytes) fail('The archive totals do not match its payload.')
  return tree
}

function observedMetadata(directory, log) {
  const documents = {}
  const read = (label, relative) => {
    const file = path.join(directory, 'ci', relative)
    if (!stat(file)) { documents[label] = { path: relative, state: 'absent' }; return null }
    try {
      const value = JSON.parse(readRegular(file, 16 * 1024 * 1024).toString('utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Not an object')
      documents[label] = { path: relative, state: 'readable' }
      return value
    } catch {
      documents[label] = { path: relative, state: 'unreadable' }
      log(`[Acceptance archive] Metadata ${label} could not be interpreted; its original bytes are retained.`)
      return null
    }
  }
  const context = read('context', 'context.json')
  const run = read('run', 'run/run.json')
  const plan = read('plan', 'plan.json')
  const text = value => typeof value === 'string' && value.length <= 512 ? value : null
  const sha = (value, length) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value) ? value : null
  return {
    documents,
    source: { repository: text(context?.repository), ref: text(context?.ref), revision: sha(context?.revision, 40), runRevision: sha(run?.revision?.commit, 40), catalogHash: sha(run?.catalogHash ?? plan?.catalogHash, 64), manifestHash: sha(run?.manifestHash, 64) },
    testRun: { present: !!run, id: text(run?.id), status: text(run?.status), evidenceIntegrity: run?.evidenceIntegrity ? { version: Number.isInteger(run.evidenceIntegrity.version) ? run.evidenceIntegrity.version : null, valid: typeof run.evidenceIntegrity.valid === 'boolean' ? run.evidenceIntegrity.valid : null, reasonCount: Array.isArray(run.evidenceIntegrity.reasons) ? run.evidenceIntegrity.reasons.length : null } : null },
    remoteUpload: { status: 'not-observed', explanation: 'A local copy does not confirm a remote upload or the enclosing workflow conclusion.' },
  }
}

function finality(freeze) {
  return { state: 'frozen', freezeSha256: freeze.freezeSha256, identity: freeze.receipt.identity, revision: freeze.receipt.revision, completion: freeze.receipt.completion }
}

function evidenceErrorCode(error) {
  return ['EVIDENCE_NOT_FROZEN', 'EVIDENCE_UNSETTLED', 'EVIDENCE_IDENTITY_MISMATCH', 'EVIDENCE_CHANGED'].includes(error?.code) ? error.code : 'EVIDENCE_NOT_FROZEN'
}

export function verifyArchive(directory) {
  const uid = owner()
  directory = path.resolve(directory)
  const root = loadRoot(path.dirname(directory), uid)
  const archiveStat = managedDirectory(directory, uid)
  const allowed = [creationName, manifestName, completionName, 'ci'].sort()
  if (JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify(allowed)) fail('The archive is pending or contains unexpected entries.')
  const records = new Map()
  for (const name of [creationName, manifestName, completionName]) {
    const value = stat(path.join(directory, name))
    if (!value?.isFile() || Number(value.uid) !== uid || mode(value) !== 0o640) fail('The archive management records have changed ownership or permissions.')
    records.set(name, value)
  }
  const created = readJson(path.join(directory, creationName)), complete = readJson(path.join(directory, completionName))
  const manifestBytes = readRegular(path.join(directory, manifestName), 64 * 1024 * 1024)
  let manifest
  try { manifest = JSON.parse(manifestBytes.toString('utf8')) }
  catch { fail('The archive manifest is not valid JSON.') }
  const request = requestIdentity(created.identity)
  if (created.kind !== 'halo-acceptance-ci-archive' || created.version !== 1 || created.rootId !== root.marker.rootId || entryName(request) !== path.basename(directory) || !/^[a-f0-9-]{36}$/.test(created.archiveId ?? '')) fail('The archive creation marker does not identify this managed entry.')
  if (manifest.kind !== 'halo-acceptance-ci-manifest' || ![1, 2].includes(manifest.version) || manifest.rootId !== created.rootId || manifest.archiveId !== created.archiveId || JSON.stringify(manifest.identity) !== JSON.stringify(request)) fail('The archive manifest identity does not match its creation marker.')
  if (complete.kind !== 'halo-acceptance-ci-complete' || complete.version !== manifest.version || complete.rootId !== created.rootId || complete.archiveId !== created.archiveId || complete.manifestSha256 !== digest(manifestBytes) || !Number.isFinite(Date.parse(complete.completedAt))) fail('The archive completion record does not match its manifest.')
  const tree = verifyPayload(directory, manifest, uid)
  let sourceFinality = { state: 'legacy-unverified' }
  if (manifest.version === 2) {
    const frozen = verifyFrozenEvidence(path.join(directory, 'ci'), { identity: request })
    sourceFinality = finality(frozen)
    if (complete.freezeSha256 !== frozen.freezeSha256 || JSON.stringify(manifest.sourceFinality) !== JSON.stringify(sourceFinality)) fail('The archive does not contain its matching frozen evidence identity.')
  }
  managedDirectory(root.directory, uid, root.directoryStat)
  managedDirectory(directory, uid, archiveStat)
  if (JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify(allowed) || [...records].some(([name, value]) => stamp(stat(path.join(directory, name))) !== stamp(value))) fail('The archive management records changed during verification.')
  return { directory, manifest, complete, sourceFinality, tree, records, directoryStat: archiveStat }
}

// A failure path is uploadable only with this invocation's original ownership proof.
export function archiveSnapshotForUpload(error) {
  const proof = error && typeof error === 'object' ? failedSnapshots.get(error) : null
  if (!proof) return null
  try {
    const { directory, uid, root, archiveStat, archiveId, request } = proof
    const currentRoot = loadRoot(root.directory, uid)
    if (currentRoot.marker.rootId !== root.marker.rootId) return null
    managedDirectory(root.directory, uid, root.directoryStat)
    managedDirectory(directory, uid, archiveStat)
    const names = fs.readdirSync(directory).sort()
    const hasComplete = names.includes(completionName), hasIncomplete = names.includes(incompleteName)
    if (hasComplete && hasIncomplete) return null
    const expected = [creationName, manifestName, 'ci', ...(hasComplete ? [completionName] : []), ...(hasIncomplete ? [incompleteName] : [])].sort()
    if (JSON.stringify(names) !== JSON.stringify(expected)) return null
    const records = new Map()
    for (const name of expected.filter(name => name !== 'ci')) {
      const value = stat(path.join(directory, name))
      if (!value?.isFile() || value.isSymbolicLink() || Number(value.uid) !== uid || mode(value) !== 0o640) return null
      records.set(name, value)
    }
    const created = readJson(path.join(directory, creationName))
    const manifestBytes = readRegular(path.join(directory, manifestName), 64 * 1024 * 1024)
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    if (created.kind !== 'halo-acceptance-ci-archive' || created.version !== 1 || created.archiveId !== archiveId || created.rootId !== root.marker.rootId || JSON.stringify(requestIdentity(created.identity)) !== JSON.stringify(request) || entryName(request) !== path.basename(directory)) return null
    if (manifest.kind !== 'halo-acceptance-ci-manifest' || manifest.version !== 2 || manifest.archiveId !== archiveId || manifest.rootId !== root.marker.rootId || JSON.stringify(manifest.identity) !== JSON.stringify(request)) return null
    if (hasIncomplete) {
      const marker = readJson(path.join(directory, incompleteName))
      if (marker.kind !== 'halo-acceptance-ci-incomplete' || marker.version !== 2 || marker.archiveId !== archiveId || marker.rootId !== root.marker.rootId || marker.manifestSha256 !== digest(manifestBytes)) return null
    }
    verifyPayload(directory, manifest, uid)
    if (hasComplete) verifyArchive(directory)
    managedDirectory(root.directory, uid, root.directoryStat)
    managedDirectory(directory, uid, archiveStat)
    if (JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify(names) || [...records].some(([name, value]) => stamp(stat(path.join(directory, name))) !== stamp(value))) return null
    return { directory, sourceFinal: false }
  } catch {
    // The caller reports withheld upload separately from the original archival failure.
    return null
  }
}

function retainArchives(root, current, controller, keep, log, checkSource) {
  checkSource()
  const verified = [], protectedEntries = [], otherControllerEntries = []
  for (const name of fs.readdirSync(root.directory).sort()) {
    if (name === rootMarker || name === lockName) continue
    const directory = path.join(root.directory, name)
    try {
      const archive = verifyArchive(directory)
      if (archive.manifest.identity.repository !== controller) {
        otherControllerEntries.push(name)
        log(`[Acceptance archive] Retained verified archive ${JSON.stringify(name)} belonging to another controller.`)
      } else if (archive.sourceFinality.state !== 'frozen') {
        protectedEntries.push(name)
        log(`[Acceptance archive] Retained legacy copy ${JSON.stringify(name)} without final-source evidence.`)
      } else {
        verified.push(archive)
      }
    } catch (error) {
      if (directory === current) throw error
      protectedEntries.push(name)
      log(`[Acceptance archive] Retained unverified entry ${JSON.stringify(name)}: ${error.message}`)
    }
  }
  if (!verified.some(archive => archive.directory === current)) fail('The new archive is no longer available; retention was not started.')
  verifyArchive(current)
  checkSource()
  const removed = []
  const eligible = verified.filter(archive => archive.directory !== current).sort((left, right) => Date.parse(left.complete.completedAt) - Date.parse(right.complete.completedAt) || left.directory.localeCompare(right.directory))
  for (const candidate of eligible.slice(0, Math.max(0, verified.length - keep))) {
    managedDirectory(root.directory, root.uid, root.directoryStat)
    managedDirectory(candidate.directory, root.uid, candidate.directoryStat)
    const checked = verifyArchive(candidate.directory)
    if (inventory(path.join(candidate.directory, 'ci')).signature !== checked.tree.signature) fail('An archive changed immediately before retention cleanup.')
    if ([...checked.records].some(([name, value]) => stamp(stat(path.join(candidate.directory, name))) !== stamp(value))) fail('An archive management record changed immediately before retention cleanup.')
    managedDirectory(candidate.directory, root.uid, checked.directoryStat)
    checkSource()
    fs.rmSync(candidate.directory, { recursive: true })
    synchronizeDirectory(root.directory)
    removed.push(path.basename(candidate.directory))
    log(`[Acceptance archive] Removed verified managed archive ${JSON.stringify(path.basename(candidate.directory))} under the ${keep}-archive retention policy.`)
  }
  return { controller, keep, removed, protectedEntries, otherControllerEntries }
}

export function archiveCi({ checkout = process.cwd(), archiveRoot = path.join(os.homedir(), '.halo-acceptance-archives'), workspace, runnerTemp, identity: requested, keep = 14, log = console.log } = {}) {
  const uid = owner()
  if (!Number.isInteger(keep) || keep < 1 || keep > 14) fail('Retention must keep between 1 and 14 verified managed archives.')
  const request = requestIdentity(requested)
  realDirectory(checkout)
  checkout = fs.realpathSync(checkout)
  const source = path.join(checkout, sourceRelative)
  directoryParents(source)
  let frozen, freezeError
  try { frozen = verifyEvidenceSource(checkout, { identity: request }) }
  catch (error) { freezeError = error }
  const initial = inventory(source)
  if (!initial.files.some(file => file.path === 'context.json')) fail('The CI evidence directory has no captured initial context.')
  const root = prepareRoot(archiveRoot, [checkout, workspace, runnerTemp], uid)
  const unlock = lockRoot(root)
  const directory = path.join(root.directory, entryName(request))
  let failure, snapshotProof
  try {
    managedDirectory(root.directory, uid, root.directoryStat)
    if (stat(directory)) fail('This controller run and attempt already has a local archive or pending copy; it will not be overwritten.', 'ARCHIVE_EXISTS')
    const archiveStat = newDirectory(directory)
    const archiveId = randomUUID(), startedAt = new Date().toISOString()
    newJson(path.join(directory, creationName), { kind: 'halo-acceptance-ci-archive', version: 1, rootId: root.marker.rootId, archiveId, identity: request, startedAt })
    snapshotProof = { directory, uid, root, archiveStat, archiveId, request }
    const destination = path.join(directory, 'ci')
    const sourceDirectories = new Map(initial.directories.map(item => [item.path, item.stat]))
    const destinationDirectories = new Map()
    for (const item of initial.directories) {
      managedDirectory(root.directory, uid, root.directoryStat)
      managedDirectory(directory, uid, archiveStat)
      const target = item.path ? path.join(destination, item.path) : destination
      if (item.path) assertParents(destination, item.path, destinationDirectories, root)
      destinationDirectories.set(item.path, newDirectory(target))
    }
    const files = initial.files.map(record => copyFile(source, destination, record, sourceDirectories, destinationDirectories, root, directory, archiveStat))
    if (inventory(source).signature !== initial.signature) fail('The CI evidence tree changed during copying; no complete archive was published.')
    const manifest = {
      kind: 'halo-acceptance-ci-manifest', version: 2, rootId: root.marker.rootId, archiveId, identity: request, startedAt,
      sourceDirectory: sourceRelative, copyMeaning: 'Complete means the listed local files were copied and verified; it is not a passing-test or baseline decision.',
      permissionModel: 'POSIX owner/group reads and owner write retained; other permissions removed',
      sourceFinality: frozen ? finality(frozen) : { state: 'unconfirmed', reasonCode: evidenceErrorCode(freezeError) },
      ...observedMetadata(directory, log),
      directories: initial.directories.map(item => item.path).filter(Boolean), files, fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    }
    managedDirectory(directory, uid, archiveStat)
    newJson(path.join(directory, manifestName), manifest)
    verifyPayload(directory, manifest, uid)
    if (inventory(source).signature !== initial.signature) fail('The original evidence changed before archive completion; the pending copy is retained.')
    managedDirectory(root.directory, uid, root.directoryStat)
    managedDirectory(directory, uid, archiveStat)
    const manifestSha256 = digest(readRegular(path.join(directory, manifestName)))
    if (!frozen) {
      const reasonCode = evidenceErrorCode(freezeError)
      newJson(path.join(directory, incompleteName), { kind: 'halo-acceptance-ci-incomplete', version: 2, rootId: root.marker.rootId, archiveId, manifestSha256, capturedAt: new Date().toISOString(), reasonCode })
      synchronizeDirectory(directory)
      synchronizeDirectory(root.directory)
      log(`[Acceptance archive] Retained a non-final snapshot (${reasonCode}); no completion or retention cleanup was performed.`)
      fail('Source evidence was not frozen before copying; the non-final snapshot is retained.', reasonCode)
    }
    const finalSource = verifyEvidenceSource(checkout, { identity: request })
    const copiedSource = verifyFrozenEvidence(destination, { identity: request })
    if (finalSource.freezeSha256 !== frozen.freezeSha256 || copiedSource.freezeSha256 !== frozen.freezeSha256) fail('The evidence freeze changed before archive publication; the pending copy is retained.', 'EVIDENCE_CHANGED')
    const complete = { kind: 'halo-acceptance-ci-complete', version: 2, rootId: root.marker.rootId, archiveId, manifestSha256, freezeSha256: frozen.freezeSha256, completedAt: new Date().toISOString() }
    newJson(path.join(directory, completionTemporary), complete)
    managedDirectory(root.directory, uid, root.directoryStat)
    managedDirectory(directory, uid, archiveStat)
    fs.linkSync(path.join(directory, completionTemporary), path.join(directory, completionName))
    synchronizeDirectory(directory)
    fs.unlinkSync(path.join(directory, completionTemporary))
    synchronizeDirectory(directory)
    synchronizeDirectory(root.directory)
    const verified = verifyArchive(directory)
    const retention = retainArchives(root, directory, request.repository, keep, log, () => {
      if (verifyEvidenceSource(checkout, { identity: request }).freezeSha256 !== frozen.freezeSha256) fail('The source freeze changed before retention; older evidence was retained.', 'EVIDENCE_CHANGED')
    })
    log(`[Acceptance archive] Verified ${files.length} files (${manifest.totalBytes} bytes) in ${directory}. Test status: ${manifest.testRun.status ?? 'no run record'}; remote upload not observed.`)
    return { directory, archiveId, manifestSha256: verified.complete.manifestSha256, sourceFinality: verified.sourceFinality, fileCount: files.length, totalBytes: manifest.totalBytes, testStatus: manifest.testRun.status, remoteUpload: 'not-observed', retention }
  } catch (error) {
    failure = error
    if (stat(directory)) error.archiveDirectory = directory
    if (snapshotProof && error && typeof error === 'object') failedSnapshots.set(error, snapshotProof)
    throw error
  } finally {
    try { unlock() }
    catch (error) { if (failure) throw new AggregateError([failure, error], 'Archival failed and its lock could not be safely released.'); throw error }
  }
}

function main() {
  if (process.argv[2] === 'verify' && process.argv.length === 4) {
    const checked = verifyArchive(process.argv[3])
    console.log(JSON.stringify({ directory: checked.directory, copyVerified: true, sourceFinality: checked.sourceFinality, files: checked.manifest.fileCount, testStatus: checked.manifest.testRun.status, remoteUpload: checked.manifest.remoteUpload.status }, null, 2))
    return
  }
  if (process.argv.length !== 2) fail('Usage: node scripts/acceptance/ci-archive.mjs [verify /absolute/archive-directory]')
  const archived = archiveCi({
    archiveRoot: process.env.HALO_ACCEPTANCE_ARCHIVE_ROOT || undefined,
    workspace: process.env.GITHUB_WORKSPACE, runnerTemp: process.env.RUNNER_TEMP,
    identity: { repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT },
  })
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `archive-directory=${archived.directory}\narchive-manifest-sha256=${archived.manifestSha256}\nsnapshot-directory=${archived.directory}\nsource-final=true\n`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    const location = archived.directory.replace(/[`<>|]/g, ' ')
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Local evidence archive\n\nVerified local copy from frozen evidence: \`${location}\` (${archived.fileCount} files). Completion describes the copy, not the test result or a baseline. Remote artifact upload has not been confirmed by this step. Retention removed ${archived.retention.removed.length} verified final archives for this controller and preserved ${archived.retention.protectedEntries.length} protected entries plus ${archived.retention.otherControllerEntries.length} verified archives belonging to other controllers.\n`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() }
  catch (error) {
    console.error(`[Acceptance archive] ${error.code ?? 'ARCHIVE_FAILED'}: ${error.message}${error.archiveDirectory ? ` Pending or completed evidence was retained at ${error.archiveDirectory}.` : ''}`)
    const snapshot = archiveSnapshotForUpload(error)
    if (snapshot && process.env.GITHUB_OUTPUT) {
      try { fs.appendFileSync(process.env.GITHUB_OUTPUT, `snapshot-directory=${snapshot.directory}\nsource-final=false\n`) }
      catch { console.error('[Acceptance archive] The safe non-final snapshot could not be announced for upload.') }
    } else if (!snapshot) console.error('[Acceptance archive] Snapshot upload withheld because no safe retained copy was confirmed.')
    if (process.env.GITHUB_STEP_SUMMARY) {
      try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Local archive stage\n\n${error.code === 'ARCHIVE_UNSUPPORTED' ? 'Unsupported on this host' : 'Failed to finish local retention'}. This is an infrastructure archival outcome, not a product-test result. Original evidence was not modified; remote upload requires a separately confirmed safe snapshot path. See the archive step log.\n`) }
      catch { console.error('[Acceptance archive] The archival outcome could not be appended to the job summary.') }
    }
    process.exitCode = error.code === 'ARCHIVE_UNSUPPORTED' ? 2 : 1
  }
}
