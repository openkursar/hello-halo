import * as fs from 'fs'
import { createHash } from 'crypto'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep, win32 } from 'path'
import { TextDecoder } from 'util'

const MAX_ENTRIES = 2000
const MAX_BYTES = 32 * 1024 * 1024
const MAX_CONTENT_BYTES = 1024 * 1024
const MAX_DEPTH = 32
const MAX_PATH_LENGTH = 1024
const LOG_TAG = '[Skills]'

type SkillAssets = Record<string, { encoding: 'base64'; content: string }>

export interface SkillPackage {
  files: Record<string, string>
  assets: SkillAssets
  // Regular-file permission bits only, keyed by package-relative path.
  modes?: Record<string, number>
  entries: Array<{ path: string; size: number; binary: boolean }>
  revision: string
}

interface Location {
  filePath: string
  root: string
  directory: boolean
}

interface TreeEntry {
  path: string
  stat: fs.Stats
  link?: string
}

interface Tree {
  location: Location
  physicalRoot: string
  root: fs.Stats
  target: fs.Stats
  link?: string
  entries: TreeEntry[]
  bytes: number
  revision: string
}

interface Directory {
  path: string
  selected: string
  ancestors: Array<{ path: string; stat: fs.Stats }>
}

interface Mutation {
  cleanup: Directory[]
  retained: Set<string>
  issues: string[]
}

/**
 * Electron's asar layer is a read-only virtual filesystem: it has no opendir, and its
 * lstat and fstat disagree on inode and timestamps. Packaged built-in skills live there.
 *
 * A name ending in `.asar` is not proof: `app.asar.unpacked` holds real files and a user may own
 * a folder called `foo.asar`. The archive is the `.asar` segment that is a regular file once
 * Electron's virtual layer is bypassed, so ordinary directories keep their strict checks.
 */
const archiveSegments = new Map<string, boolean>()

function isArchiveFile(candidate: string): boolean {
  const known = archiveSegments.get(candidate)
  if (known !== undefined) return known
  const processWithAsar = process as NodeJS.Process & { noAsar?: boolean }
  const previous = processWithAsar.noAsar
  let archive = false
  try {
    processWithAsar.noAsar = true
    archive = fs.lstatSync(candidate).isFile()
  } catch {
    archive = false
  } finally {
    processWithAsar.noAsar = previous
  }
  // The archive of a packaged app never changes while it runs; remember it, but not a miss for a path that may appear later.
  if (archive) archiveSegments.set(candidate, true)
  return archive
}

export function insideAsar(path: string): boolean {
  // Check every `.asar` segment, outermost first: a user folder named foo.asar may precede the real archive.
  for (const match of path.matchAll(/\.asar(?=[\\/]|$)/gi)) {
    if (isArchiveFile(path.slice(0, match.index + match[0].length))) return true
  }
  return false
}

function locationOf(filePath: string): Location {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0') || filePath.length > 4096) {
    throw new Error('Invalid skill file path')
  }
  const path = resolve(filePath)
  if (extname(path).toLowerCase() !== '.md') throw new Error('Skill file must be Markdown')
  const directory = basename(path) === 'SKILL.md'
  const root = directory ? dirname(path) : path
  if (dirname(root) === root) throw new Error('A filesystem root is not a skill')
  return { filePath: path, root, directory }
}

function statOrMissing(path: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function requireAbsent(path: string): void {
  if (statOrMissing(path)) throw new Error('Skill destination already exists')
}

function pathKey(path: string): string {
  return path.normalize('NFC').toLowerCase()
}

function packagePath(input: string): string {
  if (!input || input.length > MAX_PATH_LENGTH || isAbsolute(input) || win32.isAbsolute(input)) {
    throw new Error('Invalid skill package path')
  }
  const path = input.replace(/\\/g, '/')
  const segments = path.split('/')
  if (segments.length > MAX_DEPTH || segments.some(segment =>
    !segment || segment === '.' || segment === '..' || /[\x00-\x1f<>:"|?*]/.test(segment) ||
    /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
  )) throw new Error('Unsafe skill package path')
  return path
}

function registerPath(path: string, paths: Map<string, string>, files: Set<string>, file: boolean): void {
  const parts = path.split('/')
  for (let index = 1; index <= parts.length; index++) {
    const prefix = parts.slice(0, index).join('/')
    const key = pathKey(prefix)
    const previous = paths.get(key)
    if ((previous !== undefined && previous !== prefix) || (index < parts.length && files.has(key))) {
      throw new Error('Conflicting skill package paths')
    }
    if (index === parts.length && (files.has(key) || (file && previous !== undefined))) {
      throw new Error('Duplicate skill package path')
    }
    paths.set(key, prefix)
  }
  if (file) files.add(pathKey(path))
}

function stamp(stat: fs.Stats, omitChangeTime = false, stableIdentity = true): Array<number | string> {
  return [stat.dev, stableIdentity ? stat.ino : '', stat.mode, stat.size, stat.mtimeMs, omitChangeTime ? '' : stat.ctimeMs]
}

function sameStat(left: fs.Stats, right: fs.Stats): boolean {
  return JSON.stringify(stamp(left)) === JSON.stringify(stamp(right))
}

/** asar reports a fresh inode on every lstat, so identity there rests on mode, size and times. */
function sameEntry(left: fs.Stats, right: fs.Stats, path: string): boolean {
  if (!insideAsar(path)) return sameStat(left, right)
  return left.mode === right.mode && left.size === right.size && left.mtimeMs === right.mtimeMs
}

// Renaming changes the root inode's ctime; descendants must still match the original snapshot.
function treeRevision(tree: Omit<Tree, 'revision'>, relocated = false): string {
  const hash = createHash('sha256')
  // asar invents a new inode per lstat; its entries are immutable, so path, size and times identify them.
  const stable = !insideAsar(tree.physicalRoot)
  hash.update(JSON.stringify([tree.location.directory, stamp(tree.root, relocated, stable), tree.link,
    stamp(tree.target, relocated && tree.link === undefined, stable)]))
  for (const entry of tree.entries) {
    hash.update(JSON.stringify([entry.path, stamp(entry.stat, relocated && !tree.location.directory, stable), entry.link]))
  }
  return hash.digest('hex')
}

function scanTree(location: Location): Tree {
  const root = fs.lstatSync(location.root)
  const link = root.isSymbolicLink() ? fs.readlinkSync(location.root) : undefined
  const physicalRoot = fs.realpathSync(location.root)
  const target = fs.lstatSync(physicalRoot)
  if (location.directory ? !target.isDirectory() : !target.isFile()) {
    throw new Error('Skill path is not a regular file or directory')
  }
  const tree: Tree = { location, physicalRoot, root, target, link, entries: [], bytes: 0, revision: '' }
  const paths = new Map<string, string>()
  const files = new Set<string>()
  const append = (path: string, stat: fs.Stats, absolutePath: string): void => {
    if (tree.entries.length >= MAX_ENTRIES) throw new Error('Skill package exceeds 2000 entries')
    const safePath = packagePath(path)
    if (safePath !== path) throw new Error('Unsafe skill filename')
    registerPath(path, paths, files, !stat.isDirectory())
    if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) {
      throw new Error('Skill package contains a non-regular file')
    }
    if (stat.isFile()) {
      tree.bytes += stat.size
      if (tree.bytes > MAX_BYTES) throw new Error('Skill package exceeds 32 MiB')
      if (path === 'SKILL.md' && stat.size > MAX_CONTENT_BYTES) throw new Error('SKILL.md exceeds 1 MiB')
    }
    tree.entries.push({ path, stat, ...(stat.isSymbolicLink() ? { link: fs.readlinkSync(absolutePath) } : {}) })
  }
  const visit = (directory: string, prefix: string, depth: number): void => {
    if (depth > MAX_DEPTH) throw new Error('Skill package is too deeply nested')
    const before = fs.lstatSync(directory)
    if (!before.isDirectory()) throw new Error('Skill directory changed during reading')
    const visitEntry = (entry: fs.Dirent): void => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolutePath = join(directory, entry.name)
      const stat = fs.lstatSync(absolutePath)
      append(path, stat, absolutePath)
      if (stat.isDirectory()) visit(absolutePath, path, depth + 1)
    }
    if (insideAsar(directory)) {
      // The whole listing is materialized, so refuse an oversized directory before visiting it.
      const names = fs.readdirSync(directory, { withFileTypes: true })
      if (names.length > MAX_ENTRIES) throw new Error('Skill package exceeds 2000 entries')
      for (const entry of names) visitEntry(entry)
    } else {
      const handle = fs.opendirSync(directory)
      try {
        let entry: fs.Dirent | null
        while ((entry = handle.readSync()) !== null) visitEntry(entry)
      } finally {
        handle.closeSync()
      }
    }
    if (!sameEntry(before, fs.lstatSync(directory), directory)) throw new Error('Skill directory changed during reading')
  }
  if (location.directory) visit(physicalRoot, '', 0)
  else append('SKILL.md', target, physicalRoot)
  tree.entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  if (!tree.entries.some(entry => entry.path === 'SKILL.md' && !entry.stat.isDirectory())) {
    throw new Error('Skill package is missing SKILL.md')
  }
  if (!sameEntry(root, fs.lstatSync(location.root), location.root) || !sameEntry(target, fs.lstatSync(physicalRoot), physicalRoot)) {
    throw new Error('Skill changed during reading')
  }
  tree.revision = treeRevision(tree)
  return tree
}

function regularTree(tree: Tree): void {
  if (tree.entries.some(entry => entry.link !== undefined)) {
    throw new Error('Nested symbolic links are not supported in skill packages')
  }
}

function entryPath(tree: Tree, entry: TreeEntry): string {
  return tree.location.directory ? join(tree.physicalRoot, entry.path) : tree.physicalRoot
}

function readBytes(path: string, expected: fs.Stats): Buffer {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const before = fs.fstatSync(fd)
    // Packaged sources are immutable; compare the size only, as asar reports different identities.
    const unchanged = insideAsar(path) ? before.size === expected.size : sameStat(before, expected)
    if (!before.isFile() || !unchanged) throw new Error('Skill file changed during reading')
    const bytes = Buffer.alloc(expected.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (count === 0) throw new Error('Skill file changed during reading')
      offset += count
    }
    if (!insideAsar(path) && !sameStat(before, fs.fstatSync(fd))) throw new Error('Skill file changed during reading')
    return bytes
  } finally {
    fs.closeSync(fd)
  }
}

function decodeText(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_ENCODING_INVALID_ENCODED_DATA') return undefined
    throw error
  }
}

function checkRevision(location: Location, revision: string): Tree {
  if (typeof revision !== 'string' || !revision) throw new Error('Skill revision is required')
  const tree = scanTree(location)
  if (tree.revision !== revision) throw new Error('Skill changed; reload before saving')
  return tree
}

export function skillRevision(filePath: string): string {
  return scanTree(locationOf(filePath)).revision
}

export function assertSkillRevision(filePath: string, revision: string): void {
  checkRevision(locationOf(filePath), revision)
}

export function readSkillPackage(filePath: string): SkillPackage {
  const tree = scanTree(locationOf(filePath))
  regularTree(tree)
  const files: Record<string, string> = Object.create(null)
  const assets: SkillAssets = Object.create(null)
  const modes: Record<string, number> = Object.create(null)
  const entries: SkillPackage['entries'] = []
  for (const entry of tree.entries) {
    if (!entry.stat.isFile()) continue
    const bytes = readBytes(entryPath(tree, entry), entry.stat)
    const text = decodeText(bytes)
    if (text === undefined) assets[entry.path] = { encoding: 'base64', content: bytes.toString('base64') }
    else files[entry.path] = text
    modes[entry.path] = entry.stat.mode & 0o777
    entries.push({ path: entry.path, size: bytes.length, binary: text === undefined })
  }
  checkRevision(tree.location, tree.revision)
  return { files, assets, modes, entries, revision: tree.revision }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function mutate(operation: string, filePath: string, action: (mutation: Mutation) => void): void {
  const mutation: Mutation = { cleanup: [], retained: new Set(), issues: [] }
  let failure: unknown
  let failed = false
  try {
    action(mutation)
  } catch (error) {
    failed = true
    failure = error
  } finally {
    for (const directory of mutation.cleanup.reverse()) {
      if (mutation.retained.has(directory.path)) continue
      try {
        checkParent(directory)
        fs.rmSync(directory.path, { recursive: true, force: true })
      } catch (error) {
        mutation.issues.push(`Temporary files retained at ${directory.path}: ${reason(error)}`)
      }
    }
    if (failed || mutation.issues.length) {
      console.warn(`${LOG_TAG} File operation ${failed ? 'failed' : 'cleanup incomplete'}`, {
        operation, filePath, reason: [failed ? reason(failure) : '', ...mutation.issues].filter(Boolean).join('; ')
      })
    }
  }
  if (failed) throw failure
}

function checkParent(directory: Directory): void {
  for (let index = directory.ancestors.length - 1; index >= 0; index--) {
    const { path, stat } = directory.ancestors[index]
    const current = fs.lstatSync(path)
    if (!current.isDirectory() || current.dev !== stat.dev || current.ino !== stat.ino) {
      throw new Error('Skill parent directory changed')
    }
  }
  if (fs.realpathSync(directory.selected) !== directory.path) throw new Error('Skill parent directory changed')
}

// Resolve ancestors, never the selected skill root: moving a root link must move the link itself.
function safeDirectory(selected: string, create = false): Directory {
  if (!statOrMissing(selected)) {
    if (!create || dirname(selected) === selected) throw new Error('Skill parent must be a regular directory')
    const parent = safeDirectory(dirname(selected), true)
    checkParent(parent)
    const path = join(parent.path, basename(selected))
    fs.mkdirSync(path)
    const directory: Directory = { path, selected, ancestors: [{ path, stat: fs.lstatSync(path) }, ...parent.ancestors] }
    checkParent(parent)
    checkParent(directory)
    return directory
  }
  const path = fs.realpathSync(selected)
  const directory: Directory = { path, selected, ancestors: [] }
  for (let current = path; ; current = dirname(current)) {
    const stat = fs.lstatSync(current)
    if (!stat.isDirectory()) throw new Error('Skill parent must be a regular directory')
    directory.ancestors.push({ path: current, stat })
    if (dirname(current) === current) break
  }
  checkParent(directory)
  return directory
}

function workspace(parent: Directory, mutation: Mutation): string {
  checkParent(parent)
  const path = fs.mkdtempSync(join(parent.path, '.halo-skill-'))
  mutation.cleanup.push({ path, selected: path, ancestors: [{ path, stat: fs.lstatSync(path) }, ...parent.ancestors] })
  return path
}

function writeBytes(path: string, bytes: Buffer, mode: number): void {
  const fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
  try {
    fs.writeFileSync(fd, bytes)
    fs.fchmodSync(fd, mode & 0o777)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

export function prepareSkillPackage(files: Record<string, string>, assets?: SkillAssets): Map<string, Buffer> {
  if (!files || typeof files !== 'object' || Array.isArray(files) ||
    (assets !== undefined && (!assets || typeof assets !== 'object' || Array.isArray(assets)))) {
    throw new Error('Invalid skill package')
  }
  const contents = new Map<string, Buffer>()
  const paths = new Map<string, string>()
  const filePaths = new Set<string>()
  let total = 0
  const append = (rawPath: string, value: unknown, binary: boolean): void => {
    if (contents.size >= MAX_ENTRIES) throw new Error('Skill package exceeds 2000 entries')
    const path = packagePath(rawPath)
    registerPath(path, paths, filePaths, true)
    let bytes: Buffer
    if (binary) {
      const asset = value as SkillAssets[string] | undefined
      if (!asset || asset.encoding !== 'base64' || typeof asset.content !== 'string' ||
        asset.content.length > Math.ceil(MAX_BYTES / 3) * 4 || asset.content.length % 4 !== 0) {
        throw new Error('Invalid base64 skill resource')
      }
      bytes = Buffer.from(asset.content, 'base64')
      if (bytes.toString('base64') !== asset.content) throw new Error('Invalid base64 skill resource')
    } else {
      if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_BYTES) throw new Error('Invalid skill text resource')
      bytes = Buffer.from(value, 'utf8')
      if (bytes.toString('utf8') !== value) throw new Error('Invalid UTF-8 skill resource')
    }
    total += bytes.length
    if (total > MAX_BYTES) throw new Error('Skill package exceeds 32 MiB')
    if (path === 'SKILL.md' && (bytes.length > MAX_CONTENT_BYTES || decodeText(bytes) === undefined)) {
      throw new Error('SKILL.md must be UTF-8 text within 1 MiB')
    }
    contents.set(path, bytes)
  }
  for (const path in files) if (Object.hasOwn(files, path)) append(path, files[path], false)
  for (const path in assets) if (Object.hasOwn(assets, path)) append(path, assets[path], true)
  if (!contents.has('SKILL.md')) throw new Error('Skill package is missing SKILL.md')
  if (paths.size > MAX_ENTRIES) throw new Error('Skill package exceeds 2000 entries')
  return contents
}

function prepareModes(input: SkillPackage['modes'], contents: Map<string, Buffer>): Map<string, number> {
  const modes = new Map<string, number>()
  if (input === undefined) return modes
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid skill file modes')
  for (const key in input) {
    if (!Object.hasOwn(input, key)) continue
    const path = packagePath(key)
    const mode = input[key]
    if (!contents.has(path) || modes.has(path) || !Number.isInteger(mode) || mode < 0 || mode > 0o777) {
      throw new Error('Invalid skill file mode')
    }
    modes.set(path, mode)
  }
  return modes
}

function stagePackage(path: string, directory: boolean, contents: Map<string, Buffer>, original?: Tree, suppliedModes = new Map<string, number>()): void {
  if (!directory) {
    if (contents.size !== 1) throw new Error('A flat skill cannot contain supporting files')
    writeBytes(path, contents.get('SKILL.md')!, suppliedModes.get('SKILL.md') ?? original?.target.mode ?? 0o644)
    return
  }
  fs.mkdirSync(path, { mode: 0o700 })
  const modes = new Map(original?.entries.map(entry => [entry.path, entry.stat.mode]))
  for (const [name, mode] of suppliedModes) modes.set(name, mode)
  for (const [name, bytes] of contents) {
    const destination = join(path, name)
    fs.mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    writeBytes(destination, bytes, modes.get(name) ?? 0o644)
  }
  const directories = new Set<string>()
  for (const name of contents.keys()) {
    for (let parent = dirname(name); parent !== '.'; parent = dirname(parent)) directories.add(parent)
  }
  for (const name of [...directories].sort((left, right) => right.length - left.length)) {
    fs.chmodSync(join(path, name), (modes.get(name) ?? 0o755) & 0o777)
  }
  fs.chmodSync(path, (original?.target.mode ?? 0o755) & 0o777)
}

function relocatedLocation(location: Location, root: string): Location {
  return { ...location, root, filePath: location.directory ? join(root, 'SKILL.md') : root }
}

function verifyRelocated(original: Tree, root: string): void {
  const current = scanTree(relocatedLocation(original.location, root))
  if (treeRevision(current, true) !== treeRevision(original, true)) throw new Error('Skill changed during replacement')
}

function restoreBackup(backup: string, target: string, work: string, mutation: Mutation, parent: Directory, backupParent: Directory): void {
  let parentsVerified = false
  try {
    // A changed alias must not redirect recovery away from the pinned directory.
    checkParent({ ...parent, selected: parent.path })
    checkParent({ ...backupParent, selected: backupParent.path })
    parentsVerified = true
    requireAbsent(target)
    fs.renameSync(backup, target)
  } catch (error) {
    mutation.retained.add(work)
    const recovery = `original ${parentsVerified ? 'retained' : 'last known'} at ${backup}`
    mutation.issues.push(`${recovery}: ${reason(error)}`)
    throw new Error(`Skill rollback failed; ${recovery}`)
  }
}

function publishStage(stage: string, target: string, directory: boolean): void {
  requireAbsent(target)
  if (directory) fs.renameSync(stage, target)
  else fs.linkSync(stage, target)
}

export function writeSkillPackage(
  filePath: string,
  files: Record<string, string>,
  assets?: SkillAssets,
  expectedRevision?: string,
  modes?: SkillPackage['modes']
): void {
  mutate('replace package', filePath, mutation => {
    const selected = locationOf(filePath)
    const contents = prepareSkillPackage(files, assets)
    const suppliedModes = prepareModes(modes, contents)
    const parent = safeDirectory(dirname(selected.root), true)
    const location = relocatedLocation(selected, join(parent.path, basename(selected.root)))
    const original = expectedRevision === undefined ? undefined : checkRevision(location, expectedRevision)
    if (original) {
      if (original.link !== undefined) throw new Error('Replacing a symbolic-link skill is not supported')
      regularTree(original)
    } else requireAbsent(location.root)
    const work = workspace(parent, mutation)
    const stage = join(work, 'package')
    stagePackage(stage, location.directory, contents, original, suppliedModes)
    checkParent(parent)
    if (!original) {
      publishStage(stage, location.root, location.directory)
      return
    }
    checkRevision(location, expectedRevision!)
    checkParent(parent)
    const backup = join(work, 'original')
    fs.renameSync(location.root, backup)
    try {
      verifyRelocated(original, backup)
      checkParent(parent)
      publishStage(stage, location.root, location.directory)
    } catch (error) {
      restoreBackup(backup, location.root, work, mutation, parent, parent)
      throw error
    }
  })
}

export function writeSkillContent(filePath: string, content: string, expectedRevision: string): void {
  mutate('save instructions', filePath, mutation => {
    const selected = locationOf(filePath)
    const contents = prepareSkillPackage({ 'SKILL.md': content }, undefined)
    const parent = safeDirectory(dirname(selected.root))
    const location = relocatedLocation(selected, join(parent.path, basename(selected.root)))
    const tree = checkRevision(location, expectedRevision)
    if (tree.link !== undefined) throw new Error('Editing a symbolic-link skill is not supported')
    const main = tree.entries.find(entry => entry.path === 'SKILL.md')!
    if (!main.stat.isFile()) throw new Error('SKILL.md must be a regular file')
    const bytes = contents.get('SKILL.md')!
    if (tree.bytes - main.stat.size + bytes.length > MAX_BYTES) throw new Error('Skill package exceeds 32 MiB')
    const work = workspace(parent, mutation)
    const stage = join(work, 'content')
    writeBytes(stage, bytes, main.stat.mode)
    checkParent(parent)
    checkRevision(location, expectedRevision)
    checkParent(parent)
    fs.renameSync(stage, location.filePath)
  })
}

function verifyCopy(original: Tree, copy: string): void {
  const current = scanTree(relocatedLocation(original.location, copy))
  if (current.entries.length !== original.entries.length) throw new Error('Skill copy verification failed')
  for (let index = 0; index < original.entries.length; index++) {
    const left = original.entries[index]
    const right = current.entries[index]
    if (left.path !== right.path || left.stat.isDirectory() !== right.stat.isDirectory() ||
      (left.stat.mode & 0o777) !== (right.stat.mode & 0o777) || left.stat.size !== right.stat.size && left.stat.isFile()) {
      throw new Error('Skill copy verification failed')
    }
    if (left.stat.isFile() && !readBytes(entryPath(original, left), left.stat).equals(readBytes(entryPath(current, right), right.stat))) {
      throw new Error('Skill copy verification failed')
    }
  }
}

function copyTree(tree: Tree, target: string): void {
  regularTree(tree)
  if (!tree.location.directory) {
    writeBytes(target, readBytes(tree.physicalRoot, tree.target), tree.target.mode)
    return
  }
  fs.mkdirSync(target, { mode: 0o700 })
  for (const entry of tree.entries) {
    const destination = join(target, entry.path)
    if (entry.stat.isDirectory()) fs.mkdirSync(destination, { mode: 0o700 })
    else writeBytes(destination, readBytes(entryPath(tree, entry), entry.stat), entry.stat.mode)
  }
  for (const entry of [...tree.entries].reverse()) {
    if (entry.stat.isDirectory()) fs.chmodSync(join(target, entry.path), entry.stat.mode & 0o777)
  }
  fs.chmodSync(target, tree.target.mode & 0o777)
}

function directoryPath(path: string): string {
  if (statOrMissing(path) || dirname(path) === path) return fs.realpathSync(path)
  return join(directoryPath(dirname(path)), basename(path))
}

function requireOutsideSource(source: Location, target: Location): void {
  const nestedTarget = relative(source.root, target.root)
  if (source.root === target.root || (source.directory && nestedTarget && !nestedTarget.startsWith(`..${sep}`) && nestedTarget !== '..' && !isAbsolute(nestedTarget))) {
    throw new Error('Skill destination must be outside the source')
  }
}

export function moveSkillFiles(filePath: string, targetFilePath: string, expectedRevision: string): void {
  mutate('move package', filePath, mutation => {
    const selectedSource = locationOf(filePath)
    const selectedTarget = locationOf(targetFilePath)
    if (selectedSource.directory !== selectedTarget.directory) throw new Error('Moving between flat and directory skills is not supported')
    const sourceParent = safeDirectory(dirname(selectedSource.root))
    const source = relocatedLocation(selectedSource, join(sourceParent.path, basename(selectedSource.root)))
    const tree = checkRevision(source, expectedRevision)
    const target = relocatedLocation(selectedTarget, join(directoryPath(dirname(selectedTarget.root)), basename(selectedTarget.root)))
    requireOutsideSource(source, target)
    requireAbsent(target.root)
    const targetParent = safeDirectory(dirname(selectedTarget.root), true)
    if (dirname(target.root) !== targetParent.path) throw new Error('Skill parent directory changed')
    if (tree.link !== undefined) {
      if (!isAbsolute(tree.link) && resolve(sourceParent.path, tree.link) !== resolve(targetParent.path, tree.link)) {
        throw new Error('Moving this relative symbolic link would change its target')
      }
    } else regularTree(tree)
    checkParent(sourceParent)
    checkParent(targetParent)
    checkRevision(source, expectedRevision)
    checkParent(sourceParent)
    checkParent(targetParent)
    requireAbsent(target.root)
    let renamed = false
    try {
      fs.renameSync(source.root, target.root)
      renamed = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    }
    if (renamed) {
      try {
        checkParent(sourceParent)
        checkParent(targetParent)
        verifyRelocated(tree, target.root)
      } catch (error) {
        restoreBackup(target.root, source.root, target.root, mutation, sourceParent, targetParent)
        throw error
      }
      return
    }
    if (tree.link !== undefined) throw new Error('Cross-volume symbolic-link moves are not supported')
    const work = workspace(targetParent, mutation)
    const stage = join(work, 'package')
    copyTree(tree, stage)
    checkParent(sourceParent)
    checkParent(targetParent)
    verifyCopy(tree, stage)
    checkRevision(source, expectedRevision)
    checkParent(sourceParent)
    checkParent(targetParent)
    requireAbsent(target.root)
    const sourceWork = workspace(sourceParent, mutation)
    const backup = join(sourceWork, 'original')
    fs.renameSync(source.root, backup)
    try {
      verifyRelocated(tree, backup)
      checkParent(sourceParent)
      checkParent(targetParent)
      publishStage(stage, target.root, target.directory)
    } catch (error) {
      restoreBackup(backup, source.root, sourceWork, mutation, sourceParent, sourceParent)
      throw error
    }
  })
}

export function skillRemovalPath(filePath: string): string {
  return locationOf(filePath).root
}

/** Resolve ancestor aliases but never follow the selected skill's own link. */
export function prepareSkillRemoval(filePath: string, expectedRevision?: string): string {
  const selected = locationOf(filePath)
  const original = expectedRevision === undefined ? fs.lstatSync(selected.root) : checkRevision(selected, expectedRevision).root
  const parent = safeDirectory(dirname(selected.root))
  const target = join(parent.path, basename(selected.root))
  checkParent(parent)
  const current = fs.lstatSync(target)
  if (!sameStat(original, current)) throw new Error('Skill changed before deletion')
  return target
}
