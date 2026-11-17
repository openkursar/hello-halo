import { constants, type Stats } from 'fs'
import * as fs from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { isEngineSessionBinding, isEngineSessionRouting } from '../../../shared/types/engine-session'

const BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const BUSY_RETRY_DELAYS_MS = [100, 400, 1000]
const MAX_SESSION_MAP_BYTES = 16 * 1024 * 1024

export interface AppDataRelocationOptions {
  appId: string
  target: string
  /** Related destinations stay inside the main target's apps directory. */
  sources: Array<{ path: string; spaceId: string; targetPath?: string }>
  /** Resume migrated CC sessions with the destination's prompt and tool definitions. */
  reloadInstructions?: boolean
  /** An absent, private app-owned directory outside every source and target root. */
  journalPath: string
}

export interface PreparedAppDataRelocation {
  fileCount: number
  /** Call only after the app and runtime records have committed atomically. */
  commit(): Promise<void>
  rollback(): Promise<void>
}

interface Header extends AppDataRelocationOptions { version: 1 }
type Operation =
  | { type: 'mkdir'; path: string }
  | { type: 'move'; from: string; to: string; stage: string; sourceBackup: string; discard?: boolean }

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

async function retry<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await action() }
    catch (error) {
      if (!BUSY_CODES.has(codeOf(error) ?? '') || attempt >= BUSY_RETRY_DELAYS_MS.length) throw error
      if (attempt === 0) console.warn('[AppDataRelocation] Filesystem entry is busy; retrying', { code: codeOf(error) })
      await new Promise(resolve => setTimeout(resolve, BUSY_RETRY_DELAYS_MS[attempt]))
    }
  }
}

async function stat(path: string): Promise<Stats | null> {
  try { return await fs.lstat(path) }
  catch (error) {
    if (codeOf(error) === 'ENOENT') return null
    throw error
  }
}

async function syncDirectory(path: string): Promise<void> {
  // Node cannot fsync directory handles on Windows.
  if (process.platform === 'win32') return
  const handle = await fs.open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function durableWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp`
  if (await stat(temporary)) await fs.unlink(temporary)
  const handle = await fs.open(temporary, 'wx', 0o600)
  try { await handle.writeFile(content, 'utf8'); await handle.sync() }
  finally { await handle.close() }
  await retry(() => fs.rename(temporary, path))
  await syncDirectory(dirname(path))
}

function contains(parent: string, child: string): boolean {
  const suffix = relative(parent, child)
  return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
}

async function ensureJournalParent(path: string): Promise<void> {
  const entry = await stat(path)
  if (entry) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Relocation journal parent is not a real directory')
    return
  }
  await ensureJournalParent(dirname(path))
  await retry(() => fs.mkdir(path, { mode: 0o700 }))
  await syncDirectory(dirname(path))
}

async function canonical(path: string): Promise<string> {
  const entry = await stat(path)
  if (entry) return fs.realpath(path)
  const parent = dirname(path)
  if (parent === path) throw new Error('Cannot resolve relocation root')
  return join(await canonical(parent), basename(path))
}

async function assertParents(path: string): Promise<void> {
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const entry = await stat(parent)
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error('Relocation parent is not a real directory')
    if (parent === dirname(parent)) return
  }
}

async function physicalRoot(path: string): Promise<string> {
  const entry = await stat(path)
  if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error('Relocation roots must be real directories')
  return join(await canonical(dirname(path)), basename(path))
}

async function physicalEntryOptions(options: AppDataRelocationOptions): Promise<AppDataRelocationOptions> {
  const apps = dirname(options.target)
  for (const source of options.sources) {
    if (source.targetPath === undefined) continue
    if (!contains(apps, source.targetPath) || source.targetPath === apps) throw new Error('Related relocation target escapes the destination apps directory')
    // Only caller-owned root ancestors may alias; metadata inside app roots may not redirect.
    for (let parent = dirname(source.targetPath); parent !== apps; parent = dirname(parent)) {
      const entry = await stat(parent)
      if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error('Relocation parent is not a real directory')
    }
  }
  const sources: AppDataRelocationOptions['sources'] = []
  for (const source of options.sources) {
    sources.push({ ...source, path: await physicalRoot(source.path),
      ...(source.targetPath !== undefined ? { targetPath: await physicalRoot(source.targetPath) } : {}) })
  }
  return { ...options, target: await physicalRoot(options.target), journalPath: await physicalRoot(options.journalPath), sources }
}

function targetRoots(header: Header): string[] {
  return [...new Set([header.target, ...header.sources.map(source => source.targetPath ?? header.target)])]
}

async function validate(options: AppDataRelocationOptions, recovering = false): Promise<Header> {
  if (!options || typeof options.appId !== 'string' || !options.appId
    || typeof options.target !== 'string' || typeof options.journalPath !== 'string'
    || !Array.isArray(options.sources) || !isAbsolute(options.target) || !isAbsolute(options.journalPath)) {
    throw new Error('Relocation requires absolute app-owned paths')
  }
  let header: Header = {
    version: 1, appId: options.appId, target: resolve(options.target), journalPath: resolve(options.journalPath),
    sources: options.sources.map(source => {
      if (!source || typeof source.path !== 'string' || !isAbsolute(source.path)
        || typeof source.spaceId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(source.spaceId)
        || source.targetPath !== undefined && (typeof source.targetPath !== 'string' || !isAbsolute(source.targetPath))) {
        throw new Error('Invalid relocation source')
      }
      return { path: resolve(source.path), spaceId: source.spaceId,
        ...(source.targetPath !== undefined ? { targetPath: resolve(source.targetPath) } : {}) }
    }),
    ...(options.reloadInstructions !== undefined ? { reloadInstructions: options.reloadInstructions } : {}),
  }
  if (header.reloadInstructions !== undefined && typeof header.reloadInstructions !== 'boolean') throw new Error('Invalid instruction reload flag')
  if (!recovering) header = { ...await physicalEntryOptions(header), version: 1 }
  const targets = targetRoots(header)
  for (const target of targets) {
    if (!contains(dirname(header.target), target) || target === dirname(header.target)) throw new Error('Related relocation target escapes the destination apps directory')
  }
  if (Buffer.byteLength(JSON.stringify(header)) > 64 * 1024) throw new Error('Relocation header exceeds its size limit')
  const paths = [...targets, ...header.sources.map(source => source.path), header.journalPath]
  const roots: Array<{ path: string; real: string; entry: Stats | null; target: boolean }> = []
  for (const [index, path] of paths.entries()) {
    if (path === dirname(path)) throw new Error('Cannot relocate a filesystem root')
    await assertParents(path)
    const entry = await stat(path)
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error('Relocation roots must be real directories')
    roots.push({ path, real: await canonical(path), entry, target: index < targets.length })
  }
  for (let index = 0; index < roots.length; index++) {
    for (let other = index + 1; other < roots.length; other++) {
      const left = roots[index]
      const right = roots[other]
      const nestedTarget = left.target && right.target && left.path === header.target && contains(left.path, right.path)
        && left.real !== right.real && contains(left.real, right.real)
      if (!nestedTarget && (contains(left.path, right.path) || contains(right.path, left.path)
        || contains(left.real, right.real) || contains(right.real, left.real)
        || (left.entry && right.entry && left.entry.dev === right.entry.dev && left.entry.ino === right.entry.ino))) {
        throw new Error('Relocation roots overlap or alias one another')
      }
    }
  }
  // All special maps are checked before a fast directory rename can bypass the merge walker.
  for (const root of paths.slice(0, -1)) {
    const runs = await stat(join(root, 'runs'))
    if (runs?.isDirectory() && !runs.isSymbolicLink()) await readSessionMap(join(root, 'runs', '_session-ids.json'))
  }
  if (!recovering) {
    for (const source of header.sources.filter(source => (source.targetPath ?? header.target) === header.target)) {
      for (const target of targets.filter(target => target !== header.target && contains(header.target, target))) {
        const nested = join(source.path, relative(header.target, target))
        await assertParents(nested)
        const entry = await stat(nested)
        if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error('Nested relocation target is not a real directory')
        const runs = join(nested, 'runs')
        await assertParents(join(runs, '_session-ids.json'))
        await readSessionMap(join(runs, '_session-ids.json'))
      }
    }
  }
  return header
}

async function readSessionMap(path: string): Promise<Record<string, unknown> | null> {
  const entry = await stat(path)
  if (!entry) return null
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_SESSION_MAP_BYTES) {
    throw new Error('Session binding map is not a bounded regular file')
  }
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let raw: Buffer
  try {
    raw = Buffer.alloc(Math.min(entry.size + 1, MAX_SESSION_MAP_BYTES + 1))
    let offset = 0
    while (offset < raw.length) {
      const { bytesRead } = await handle.read(raw, offset, raw.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > entry.size) throw new Error('Session binding map changed during relocation')
    raw = raw.subarray(0, offset)
  } finally { await handle.close() }
  const parsed: unknown = JSON.parse(raw.toString('utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Malformed session binding map')
  for (const value of Object.values(parsed)) {
    if (typeof value === 'string' && value.length > 0 && value.length <= 512) continue
    if (isEngineSessionBinding(value)) {
      const reload = (value as unknown as Record<string, unknown>).useCurrentInstructions
      if (reload === undefined || reload === true && value.engineId === 'anthropic') continue
    }
    if (isEngineSessionRouting(value) && !('useCurrentInstructions' in value) && !('legacySessionId' in value)) continue
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const legacy = value as Record<string, unknown>
      if (legacy.version === 1 && legacy.useCurrentInstructions === true && typeof legacy.legacySessionId === 'string'
        && legacy.legacySessionId.length > 0 && legacy.legacySessionId.length <= 512
        && !('engineId' in legacy) && !('sessionId' in legacy)) continue
    }
    throw new Error('Malformed session binding map entry')
  }
  return parsed as Record<string, unknown>
}

async function countFiles(path: string): Promise<number> {
  const entry = await fs.lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink()) return 1
  let count = 0
  const directory = await fs.opendir(path)
  for await (const child of directory) count += await countFiles(join(path, child.name))
  return count
}

async function copyEntry(from: string, to: string): Promise<void> {
  const entry = await fs.lstat(from)
  if (entry.isSymbolicLink()) {
    const link = await fs.readlink(from)
    await retry(() => fs.symlink(link, to))
    return
  }
  if (entry.isDirectory()) {
    await retry(() => fs.mkdir(to, { mode: entry.mode | 0o700 }))
    const directory = await fs.opendir(from)
    for await (const child of directory) await copyEntry(join(from, child.name), join(to, child.name))
    await fs.chmod(to, entry.mode)
    await fs.utimes(to, entry.atime, entry.mtime)
    await syncDirectory(to)
    return
  }
  if (!entry.isFile()) throw new Error('Unsupported filesystem entry in app data')
  await retry(() => fs.copyFile(from, to, constants.COPYFILE_EXCL))
  await fs.chmod(to, entry.mode)
  await fs.utimes(to, entry.atime, entry.mtime)
  const handle = await fs.open(to, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function removeEntry(path: string): Promise<void> {
  const entry = await stat(path)
  if (!entry) {
    if (await stat(dirname(path))) await syncDirectory(dirname(path))
    return
  }
  if (entry.isDirectory() && !entry.isSymbolicLink()) {
    const directory = await fs.opendir(path)
    for await (const child of directory) await removeEntry(join(path, child.name))
    await retry(() => fs.rmdir(path))
  } else {
    await retry(() => fs.unlink(path))
  }
  await syncDirectory(dirname(path))
}

async function rename(from: string, to: string): Promise<void> {
  await retry(() => fs.rename(from, to))
  await syncDirectory(dirname(to))
  if (dirname(from) !== dirname(to)) await syncDirectory(dirname(from))
}

function operationPath(journalPath: string, index: number): string {
  return join(journalPath, `${String(index).padStart(12, '0')}.json`)
}

async function lastOperation(journalPath: string): Promise<number> {
  let last = 0
  let count = 0
  const directory = await fs.opendir(journalPath)
  for await (const entry of directory) {
    if (/^\d{12}\.json$/.test(entry.name)) {
      last = Math.max(last, Number(entry.name.slice(0, 12)))
      count++
    }
  }
  if (last !== count) throw new Error('Relocation operation log has a gap')
  return last
}

async function readRecord(path: string, limit = 64 * 1024): Promise<unknown> {
  await assertParents(path)
  const entry = await fs.lstat(path)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > limit) throw new Error('Invalid relocation journal record')
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const bytes = Buffer.alloc(limit + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > limit) throw new Error('Relocation journal record exceeds its size limit')
    return JSON.parse(bytes.subarray(0, offset).toString('utf8'))
  } finally { await handle.close() }
}

async function marker(path: string): Promise<boolean> {
  const entry = await stat(path)
  if (entry && (!entry.isFile() || entry.isSymbolicLink() || entry.size !== 0)) throw new Error('Invalid relocation journal marker')
  return entry !== null
}

function movePaths(header: Header, from: string, to: string, recordPath: string): { stage: string; sourceBackup: string } {
  const id = basename(dirname(recordPath)) + '-' + basename(recordPath)
  const sourceRoot = header.sources.find(source => contains(source.path, from))?.path ?? from
  const paths = { stage: `${to}.relocation-${id}`, sourceBackup: `${sourceRoot}.relocation-source-${id}` }
  for (const path of Object.values(paths)) {
    if ([...targetRoots(header), header.journalPath, ...header.sources.map(source => source.path)].some(root => contains(path, root))
      || header.sources.some(source => contains(source.path, path))) throw new Error('Relocation staging path overlaps a data root')
  }
  return paths
}

async function readOperation(header: Header, index: number): Promise<Operation> {
  const recordPath = operationPath(header.journalPath, index)
  const operation = await readRecord(recordPath) as Operation
  const normalized = (path: unknown): path is string => typeof path === 'string' && isAbsolute(path) && resolve(path) === path
  const inRoot = (path: string, root: string) => contains(root, path)
  const targets = targetRoots(header)
  const sessionMaps = targets.map(target => join(target, 'runs', '_session-ids.json'))
  const inData = (path: string) => targets.some(target => inRoot(path, target)) || header.sources.some(source => inRoot(path, source.path))
  if (operation?.type === 'mkdir') {
    if (!normalized(operation.path) || !targets.some(target => inRoot(operation.path, target) || contains(operation.path, target))
      || contains(operation.path, header.journalPath) || header.sources.some(source => contains(operation.path, source.path))) {
      throw new Error('Invalid relocation directory operation')
    }
    await assertParents(operation.path)
    return operation
  }
  if (operation?.type !== 'move' || !normalized(operation.from) || !normalized(operation.to)
    || (operation.discard !== undefined && operation.discard !== true)) throw new Error('Invalid relocation move operation')
  const generated = dirname(operation.from) === header.journalPath && /^map-\d+\.json$/.test(basename(operation.from))
  const backup = `${operation.from}.relocation-backup-${index}`
  const fromSource = header.sources.find(source => inRoot(operation.from, source.path))
  if (!(fromSource && inRoot(operation.to, fromSource.targetPath ?? header.target) && !operation.discard
    || sessionMaps.includes(operation.from) && operation.to === backup && operation.discard
    || generated && sessionMaps.includes(operation.to) && !operation.discard)) {
    throw new Error('Relocation operation escapes its data roots')
  }
  if (!inData(operation.to) || operation.from === operation.to) throw new Error('Invalid relocation move destination')
  const paths = movePaths(header, operation.from, operation.to, recordPath)
  if (paths.stage !== operation.stage || paths.sourceBackup !== operation.sourceBackup) throw new Error('Invalid relocation staging paths')
  for (const path of [operation.from, operation.to, operation.stage, operation.sourceBackup]) await assertParents(path)
  return operation
}

async function undoOperation(operation: Operation, recordPath: string): Promise<void> {
  if (operation.type === 'mkdir') {
    if (await stat(operation.path)) {
      await retry(() => fs.rmdir(operation.path))
      await syncDirectory(dirname(operation.path))
    }
    return
  }
  if (await marker(`${recordPath}.copy`)) {
    // The source backup is renamed back only after deletion has been durably acknowledged.
    // A replay after restoration must not delete a target restored by an earlier operation.
    if (!await marker(`${recordPath}.copy-removed`)) {
      if (!await stat(operation.sourceBackup) && !await stat(operation.from)) throw new Error('Relocation copy source disappeared before rollback')
      await removeEntry(operation.to)
      await removeEntry(operation.stage)
      await durableWrite(`${recordPath}.copy-removed`, '')
    }
    if (await stat(operation.sourceBackup)) {
      if (await stat(operation.from)) throw new Error('Cannot restore relocation over an occupied source')
      await rename(operation.sourceBackup, operation.from)
    } else if (!await stat(operation.from)) throw new Error('Relocation copy source disappeared before rollback')
    await syncDirectory(dirname(operation.from))
    if (dirname(operation.from) !== dirname(operation.sourceBackup)) await syncDirectory(dirname(operation.sourceBackup))
    return
  }
  const source = await stat(operation.from)
  const target = await stat(operation.to)
  if (source && target) throw new Error('Cannot roll back relocation over an occupied source')
  if (!source && target) await rename(operation.to, operation.from)
  if (!source && !target) throw new Error('Both sides of a relocation operation disappeared')
  await syncDirectory(dirname(operation.from))
  if (dirname(operation.from) !== dirname(operation.to)) await syncDirectory(dirname(operation.to))
}

async function removeEmptyDirectories(path: string): Promise<void> {
  const entry = await stat(path)
  if (!entry) return
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Relocation source contains an unexpected entry after merge')
  const directory = await fs.opendir(path)
  for await (const child of directory) await removeEmptyDirectories(join(path, child.name))
  await retry(() => fs.rmdir(path))
  await syncDirectory(dirname(path))
}

async function cleanupJournal(journalPath: string, outcome: string): Promise<void> {
  const directory = await fs.opendir(journalPath)
  for await (const entry of directory) {
    if (entry.name !== outcome) await removeEntry(join(journalPath, entry.name))
  }
  await removeEntry(join(journalPath, outcome))
  await retry(() => fs.rmdir(journalPath))
  await syncDirectory(dirname(journalPath))
}

async function finishJournal(journalPath: string, committed: boolean): Promise<void> {
  await assertParents(journalPath)
  const root = await fs.lstat(journalPath)
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Relocation journal must be a real directory')
  await syncDirectory(journalPath)
  const outcome = committed ? 'committed' : 'rolled-back'
  const opposite = committed ? 'rolled-back' : 'committed'
  if (await marker(join(journalPath, opposite))) throw new Error('Relocation outcome disagrees with the database')
  if (await marker(join(journalPath, outcome))) {
    await cleanupJournal(journalPath, outcome)
    return
  }
  const headerPath = join(journalPath, 'header.json')
  if (!await stat(headerPath)) {
    const directory = await fs.opendir(journalPath)
    for await (const entry of directory) {
      if (entry.name !== 'header.json.tmp') throw new Error('Relocation journal header is missing')
    }
    // An empty directory is also the last step of interrupted, completed cleanup.
    await removeEntry(journalPath)
    return
  }
  const rawHeader = await readRecord(headerPath) as Header
  if (rawHeader?.version !== 1 || rawHeader.journalPath !== journalPath) throw new Error('Invalid relocation journal')
  const header = await validate(rawHeader, true)
  if (committed && !await marker(join(journalPath, 'prepared'))) throw new Error('Cannot commit an incomplete relocation')
  const last = await lastOperation(journalPath)
  // Validate the entire log before executing any destructive recovery step.
  for (let index = 1; index <= last; index++) {
    if (!await stat(operationPath(journalPath, index))) throw new Error('Relocation operation log has a gap')
    await readOperation(header, index)
  }
  if (!committed) {
    for (let index = last; index > 0; index--) {
      const recordPath = operationPath(journalPath, index)
      if (await marker(`${recordPath}.undone`)) continue
      await undoOperation(await readOperation(header, index), recordPath)
      await durableWrite(`${recordPath}.undone`, '')
    }
  } else {
    for (let index = 1; index <= last; index++) {
      const operation = await readOperation(header, index)
      if (operation.type !== 'move') continue
      if (operation.discard) await removeEntry(operation.to)
      await removeEntry(operation.stage)
      await removeEntry(operation.sourceBackup)
    }
    for (const source of header.sources) await removeEmptyDirectories(source.path)
  }
  await durableWrite(join(journalPath, outcome), '')
  await cleanupJournal(journalPath, outcome)
}

/** Recover before any app writer starts; the caller's atomic database transaction decides the outcome. */
export async function recoverAppDataRelocation(journalPath: string, committed: boolean): Promise<void> {
  journalPath = resolve(journalPath)
  try {
    journalPath = await physicalRoot(journalPath)
    if (!await stat(journalPath)) return
    await finishJournal(journalPath, committed)
    console.log('[AppDataRelocation] Recovered app data relocation', { journalPath, committed })
  } catch (error) {
    console.error('[AppDataRelocation] Recovery failed; journal retained', { journalPath, committed, error })
    throw error
  }
}

/** Moves only caller-supplied app roots. Writers must stay quiescent until commit or rollback finishes. */
export async function prepareAppDataRelocation(options: AppDataRelocationOptions): Promise<PreparedAppDataRelocation> {
  const header = await validate(options)
  const { appId, target, sources, journalPath } = header
  await ensureJournalParent(dirname(journalPath))
  await assertParents(journalPath)
  await fs.mkdir(journalPath, { mode: 0o700 })
  await syncDirectory(dirname(journalPath))
  let index = 0
  let fileCount = 0
  let settled: 'committed' | 'rolled-back' | undefined

  async function record(operation: Operation): Promise<string> {
    const content = JSON.stringify(operation)
    if (Buffer.byteLength(content) > 64 * 1024) throw new Error('Relocation operation exceeds its size limit')
    const path = operationPath(journalPath, ++index)
    await durableWrite(path, content)
    return path
  }

  async function ensureDirectory(path: string): Promise<void> {
    const entry = await stat(path)
    if (entry) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Relocation parent is not a real directory')
      return
    }
    await ensureDirectory(dirname(path))
    await record({ type: 'mkdir', path })
    await retry(() => fs.mkdir(path))
    await syncDirectory(dirname(path))
  }

  async function move(from: string, to: string, discard = false): Promise<void> {
    await assertParents(from)
    await assertParents(to)
    const paths = movePaths(header, from, to, operationPath(journalPath, index + 1))
    const { stage, sourceBackup } = paths
    if (await stat(to) || await stat(stage) || await stat(sourceBackup)) throw new Error('Relocation destination or staging path is occupied')
    const recordPath = await record({ type: 'move', from, to, ...paths, ...(discard ? { discard: true } : {}) })
    try { await rename(from, to) }
    catch (error) {
      if (codeOf(error) !== 'EXDEV') throw error
      await durableWrite(`${recordPath}.copy`, '')
      await rename(from, sourceBackup)
      await copyEntry(sourceBackup, stage)
      await rename(stage, to)
    }
  }

  async function conflictPath(path: string, spaceId: string): Promise<string> {
    const base = `${path}.from-${spaceId}`
    let candidate = base
    let suffix = 1
    while (await stat(candidate)) candidate = `${base}.${suffix++}`
    return candidate
  }

  async function replaceSessionMap(path: string, content: string): Promise<void> {
    if (Buffer.byteLength(content) > MAX_SESSION_MAP_BYTES) throw new Error('Merged session binding map exceeds the relocation size limit')
    const backup = `${path}.relocation-backup-${index + 1}`
    await move(path, backup, true)
    const generated = join(journalPath, `map-${index}.json`)
    await durableWrite(generated, content)
    await move(generated, path)
  }

  async function reloadSessionInstructions(root: string): Promise<void> {
    const path = join(root, 'runs', '_session-ids.json')
    const runs = await stat(dirname(path))
    if (!runs) return
    if (!runs.isDirectory() || runs.isSymbolicLink()) throw new Error('Session binding map parent is not a real directory')
    const map = await readSessionMap(path)
    if (!map) return
    let changed = false
    const updated = Object.fromEntries(Object.entries(map).map(([key, value]) => {
      if (typeof value === 'string') {
        changed = true
        return [key, { version: 1, legacySessionId: value, useCurrentInstructions: true }]
      }
      if (isEngineSessionBinding(value) && value.engineId === 'anthropic'
        && (value as unknown as Record<string, unknown>).useCurrentInstructions !== true) {
        changed = true
        return [key, { ...value, useCurrentInstructions: true }]
      }
      return [key, value]
    }))
    if (changed) await replaceSessionMap(path, JSON.stringify(updated))
  }

  async function merge(from: string, to: string, spaceId: string, relativePath = ''): Promise<void> {
    const source = await fs.lstat(from)
    const destination = await stat(to)
    if (!destination) {
      fileCount += await countFiles(from)
      await move(from, to)
      return
    }
    if (source.isDirectory() && !source.isSymbolicLink() && destination.isDirectory() && !destination.isSymbolicLink()) {
      const directory = await fs.opendir(from)
      for await (const child of directory) await merge(join(from, child.name), join(to, child.name), spaceId, join(relativePath, child.name))
      return
    }
    if (relativePath === join('runs', '_session-ids.json')) {
      const oldMap = await readSessionMap(from)
      const newMap = await readSessionMap(to)
      if (!oldMap || !newMap) throw new Error('Session binding map disappeared during relocation')
      const merged = JSON.stringify({ ...oldMap, ...newMap })
      if (Buffer.byteLength(merged) > MAX_SESSION_MAP_BYTES) throw new Error('Merged session binding map exceeds the relocation size limit')
      const sidecar = await conflictPath(to, spaceId)
      console.warn('[AppDataRelocation] Preserving source session bindings beside merged map', { appId, path: sidecar })
      await move(from, sidecar)
      await replaceSessionMap(to, merged)
      fileCount++
      return
    }
    const sidecar = await conflictPath(to, spaceId)
    console.warn('[AppDataRelocation] Preserving conflicting source entry', { appId, from, to: sidecar })
    fileCount += await countFiles(from)
    await move(from, sidecar)
  }

  try {
    await durableWrite(join(journalPath, 'header.json'), JSON.stringify(header))
    console.log('[AppDataRelocation] Preparing app data relocation', { appId, target, sourceCount: sources.length })
    // Main-root moves precede nested metadata merges, independent of caller ordering.
    const ordered = [...sources.filter(source => (source.targetPath ?? target) === target),
      ...sources.filter(source => (source.targetPath ?? target) !== target)]
    for (const source of ordered) {
      if (!await stat(source.path)) {
        console.warn('[AppDataRelocation] Historical app data source is missing', { appId, path: source.path })
        continue
      }
      const destination = source.targetPath ?? target
      await ensureDirectory(dirname(destination))
      await merge(source.path, destination, source.spaceId)
    }
    for (const destination of targetRoots(header)) {
      await ensureDirectory(destination)
      if (header.reloadInstructions) await reloadSessionInstructions(destination)
    }
    await durableWrite(join(journalPath, 'prepared'), '')
    console.log('[AppDataRelocation] App data relocation prepared', { appId, target, fileCount })
  } catch (error) {
    console.error('[AppDataRelocation] Preparation failed; rolling back', { appId, journalPath, error })
    try { await recoverAppDataRelocation(journalPath, false) }
    catch (rollbackError) { throw new AggregateError([error, rollbackError], 'App data relocation failed and rollback requires recovery') }
    throw error
  }
  return {
    fileCount,
    async commit() {
      if (settled === 'committed') return
      if (settled) throw new Error('App data relocation was already rolled back')
      await recoverAppDataRelocation(journalPath, true)
      settled = 'committed'
      console.log('[AppDataRelocation] App data relocation committed', { appId, target, fileCount })
    },
    async rollback() {
      if (settled === 'rolled-back') return
      if (settled) throw new Error('App data relocation was already committed')
      await recoverAppDataRelocation(journalPath, false)
      settled = 'rolled-back'
    },
  }
}
