import { createHash } from 'crypto'
import { constants, promises as fsp, type Stats } from 'fs'
import { isAbsolute, join, parse, relative, sep } from 'path'
import { CliToolError } from './errors'
import { isSafeRelativePath } from './manifest'

export const BASE_SUPPORT_FILE = '.halo-support.json'
const PACKAGE_ROOTS = new Set(['payload', 'manifest.json', 'guide', 'licenses'])
const MAX_FILE_BYTES = 1024 * 1024
const MAX_FILES = 32
const SUPPORT_OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
export const SUPPORT_FAILURE = 'Required Halo command files are missing, damaged, or misconfigured. Ask your administrator to repair the Halo installation.'

export interface CliSupportFilesConfig {
  productDir: string
  files: unknown
}

interface SupportFile {
  index: number
  target: string
  bytes: Buffer
}

export interface SupportFileExpectation {
  target: string
  size: number
  sha256: string
}

export interface SupportCheck {
  root: string
  files: SupportFileExpectation[]
}

type Log = Pick<Console, 'error'>

export function supportError(): CliToolError {
  return new CliToolError('SUPPORT_FILES_INVALID', SUPPORT_FAILURE)
}

function invalid(log: Log, field: string, reason: string): CliToolError {
  log.error('[CliTools] Required support files rejected', { field, reason })
  return supportError()
}

function portablePath(path: unknown): path is string {
  return typeof path === 'string' && isSafeRelativePath(path) && path.split('/').every(segment =>
    !/[\x00-\x1f<>:"|?*\[\]{}!]/.test(segment) && !/[. ]$/.test(segment) &&
    !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment))
}

function hasCode(error: unknown, ...codes: string[]): boolean {
  return codes.includes((error as NodeJS.ErrnoException).code ?? '')
}

export async function supportPathExists(path: string): Promise<boolean> {
  try {
    await fsp.lstat(path)
    return true
  } catch (err) {
    if (!hasCode(err, 'ENOENT')) throw err
    return false
  }
}

export async function assertRealDirectories(path: string): Promise<void> {
  const { root } = parse(path)
  if (!isAbsolute(path) || !root) throw supportError()
  let current = root
  for (const segment of relative(root, path).split(sep)) {
    current = join(current, segment)
    if (!(await fsp.lstat(current)).isDirectory()) throw supportError()
  }
  if (await fsp.realpath(path) !== path) throw supportError()
}

async function readContainedFile(root: string, target: string, expectedSize?: number): Promise<Buffer> {
  if (!portablePath(target)) throw supportError()
  const segments = target.split('/')
  let path = root
  for (const segment of segments.slice(0, -1)) {
    path = join(path, segment)
    if (!(await fsp.lstat(path)).isDirectory()) throw supportError()
  }
  path = join(path, segments[segments.length - 1])
  const before = await fsp.lstat(path)
  if (!before.isFile() || before.nlink !== 1 || before.size === 0 || before.size > MAX_FILE_BYTES ||
      (expectedSize !== undefined && before.size !== expectedSize) || await fsp.realpath(path) !== path) throw supportError()
  const file = await fsp.open(path, SUPPORT_OPEN_FLAGS)
  try {
    const unchanged = (stat: Stats): boolean => stat.isFile() && stat.nlink === 1 &&
      stat.size === before.size && stat.ino === before.ino && stat.dev === before.dev
    if (!unchanged(await file.stat())) throw supportError()
    const bytes = Buffer.alloc(before.size + 1)
    let read = 0
    while (read < bytes.length) {
      const { bytesRead } = await file.read(bytes, read, bytes.length - read, read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    if (read !== before.size || !unchanged(await fsp.lstat(path))) throw supportError()
    return bytes.subarray(0, read)
  } finally {
    await file.close()
  }
}

export async function loadSupportFiles(config: CliSupportFilesConfig | undefined, log: Log): Promise<SupportFile[]> {
  if (!config) return []
  if (!Array.isArray(config.files) || config.files.length > MAX_FILES) {
    throw invalid(log, 'cliTools.supportFiles', 'list-or-limit')
  }
  if (config.files.length === 0) return []
  let root: string
  try {
    root = await fsp.realpath(config.productDir)
    await assertRealDirectories(root)
  } catch {
    throw invalid(log, 'cliTools.supportFiles', 'invalid-deployment-directory')
  }
  const files: SupportFile[] = []
  const claimed = new Set<string>()
  const directories = new Map<string, string>()
  for (const [index, entry] of config.files.entries()) {
    const field = `cliTools.supportFiles[${index}]`
    const target: unknown = entry?.target
    if (!portablePath(target) || PACKAGE_ROOTS.has(target.split('/')[0].toLowerCase()) ||
        target.split('/')[0].toLowerCase() === BASE_SUPPORT_FILE) {
      throw invalid(log, `${field}.target`, 'invalid-path')
    }
    const key = target.normalize('NFC').toLowerCase()
    if (claimed.has(key) || directories.has(key)) throw invalid(log, `${field}.target`, 'collision')
    const segments = target.split('/')
    for (let size = 1; size < segments.length; size++) {
      const directory = segments.slice(0, size).join('/')
      const folded = directory.normalize('NFC').toLowerCase()
      const previous = directories.get(folded)
      if (claimed.has(folded) || (previous !== undefined && previous !== directory)) {
        throw invalid(log, `${field}.target`, 'collision')
      }
      directories.set(folded, directory)
    }
    const source: unknown = entry?.source
    if (!portablePath(source)) throw invalid(log, `${field}.source`, 'invalid-path')
    let bytes: Buffer
    try {
      bytes = await readContainedFile(root, source)
    } catch {
      throw invalid(log, `${field}.source`, 'not-a-contained-nonempty-regular-file-within-limit')
    }
    claimed.add(key)
    files.push({ index, target, bytes })
  }
  return files.sort((a, b) => a.target < b.target ? -1 : a.target > b.target ? 1 : 0)
}

export function supportExpectations(files: SupportFile[]): SupportFileExpectation[] {
  return files.map(({ target, bytes }) => ({ target, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }))
}

export function supportDigest(files: SupportFileExpectation[]): string {
  const hash = createHash('sha256')
  for (const { target, sha256 } of files) hash.update(target).update('\0').update(Buffer.from(sha256, 'hex'))
  return hash.digest('hex')
}

export async function assertSupportFiles({ root, files }: SupportCheck): Promise<void> {
  await assertRealDirectories(root)
  for (const { target, size, sha256 } of files) {
    const bytes = await readContainedFile(root, target, size)
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw supportError()
  }
}

export async function placeSupportFiles(dir: string, files: SupportFile[], log: Log): Promise<void> {
  for (const file of files) {
    const segments = file.target.split('/')
    let parent = dir
    try {
      for (const segment of segments.slice(0, -1)) {
        parent = join(parent, segment)
        if (!await supportPathExists(parent)) await fsp.mkdir(parent)
        else if (!(await fsp.lstat(parent)).isDirectory()) throw supportError()
      }
      await fsp.writeFile(join(parent, segments[segments.length - 1]), file.bytes, { flag: 'wx', mode: 0o444 })
    } catch (err) {
      throw invalid(log, `cliTools.supportFiles[${file.index}].target`,
        hasCode(err, 'EEXIST', 'ENOTDIR', 'EISDIR') || err instanceof CliToolError ? 'collision' : 'write-failed')
    }
  }
}

export async function copyPackageTree(source: string, destination: string): Promise<void> {
  for (const entry of await fsp.readdir(source, { withFileTypes: true })) {
    if (!PACKAGE_ROOTS.has(entry.name.toLowerCase())) continue
    await fsp.cp(join(source, entry.name), join(destination, entry.name), {
      recursive: true, force: false, errorOnExist: true, mode: constants.COPYFILE_FICLONE,
      filter: async path => {
        const stat = await fsp.lstat(path)
        if (stat.isFile() || stat.isDirectory()) return true
        throw supportError()
      },
    })
  }
}

export function renderSupportPreload(check: SupportCheck | null): string {
  return `// Generated by Halo (cli-tools). Do not edit.
'use strict'
try {
  const check = ${JSON.stringify(check)}
  if (!check) throw new Error()
  const fs = require('node:fs')
  const path = require('node:path')
  const { createHash } = require('node:crypto')
  const { root, files } = check
  const volume = path.parse(root).root
  const directory = name => { if (!fs.lstatSync(name).isDirectory()) throw new Error() }
  if (!volume) throw new Error()
  let ancestor = volume
  for (const part of path.relative(volume, root).split(path.sep)) {
    ancestor = path.join(ancestor, part)
    directory(ancestor)
  }
  if (fs.realpathSync(root) !== root) throw new Error()
  for (const { target, size, sha256 } of files) {
    const parts = target.split('/')
    if (parts.some(part => !part || part === '.' || part === '..' || /[\\\\:]/.test(part))) throw new Error()
    let name = root
    for (const part of parts.slice(0, -1)) {
      name = path.join(name, part)
      directory(name)
    }
    name = path.join(name, parts[parts.length - 1])
    const before = fs.lstatSync(name)
    if (!before.isFile() || before.nlink !== 1 || before.size !== size || size <= 0 || size > ${MAX_FILE_BYTES} ||
        fs.realpathSync(name) !== name) throw new Error()
    const unchanged = stat => stat.isFile() && stat.nlink === 1 && stat.size === size &&
      stat.dev === before.dev && stat.ino === before.ino
    const fd = fs.openSync(name, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
    try {
      if (!unchanged(fs.fstatSync(fd))) throw new Error()
      const bytes = Buffer.allocUnsafe(size + 1)
      let read = 0
      while (read < bytes.length) {
        const count = fs.readSync(fd, bytes, read, bytes.length - read, read)
        if (count === 0) break
        read += count
      }
      if (read !== size || !unchanged(fs.lstatSync(name)) || createHash('sha256').update(bytes.subarray(0, read)).digest('hex') !== sha256) {
        throw new Error()
      }
    } finally {
      fs.closeSync(fd)
    }
  }
} catch {
  require('node:fs').writeSync(2, ${JSON.stringify(`SUPPORT_FILES_INVALID: ${SUPPORT_FAILURE}\n`)})
  process.exit(1)
}
`
}
