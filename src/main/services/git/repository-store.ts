import { randomUUID } from 'crypto'
import { lstat, mkdir, open, rename, unlink } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { getSpace, getSpaceDir } from '../space.service'
import { GitError } from './errors'

const MAX_ROOTS = 64
const MAX_DISMISSED_ROOTS = 256
const MAX_FILE_BYTES = 1024 * 1024
const MAX_PENDING_FILES = 32
const MAX_PENDING_WRITES = 128

export interface RepositoryRecords {
  roots: string[]
  dismissedRoots: string[]
}

interface RepositoryFile extends RepositoryRecords {
  version: 2
  workingDir: string
}

// Only pending writes are resident; each file's queue disappears when idle.
const writes = new Map<string, Promise<boolean>>()
let pendingWrites = 0

function storeFile(spaceId: string): string {
  const space = getSpace(spaceId)
  if (!space) throw new GitError('GIT_INVALID_ARGUMENT', `Unknown space: ${spaceId}`)
  return join(space.isTemp ? space.path : join(space.path, '.halo'), 'git', 'repositories.json')
}

function isNormalizedPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && !value.includes('\0') && isAbsolute(value) && resolve(value) === value
}

function isInside(workingDir: string, root: string): boolean {
  const path = relative(workingDir, root)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function isRootList(value: unknown, workingDir: string, limit: number): value is string[] {
  return Array.isArray(value) && value.length <= limit &&
    value.every((root) => isNormalizedPath(root) && isInside(workingDir, root)) && new Set(value).size === value.length
}

function requireSpaceIdentity(spaceId: string, workingDir: string, file: string): void {
  const currentDir = getSpaceDir(spaceId)
  if (!currentDir || resolve(currentDir) !== workingDir || storeFile(spaceId) !== file) {
    throw new GitError('GIT_INVALID_ARGUMENT', 'The space changed while saving repositories; retry the selection')
  }
}

async function readRecords(file: string, workingDir: string): Promise<RepositoryRecords> {
  try {
    const entry = await lstat(file)
    if (!entry.isFile() || entry.size > MAX_FILE_BYTES) throw new Error('Unexpected file type or size')
    const handle = await open(file, 'r')
    let text: string
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('Unexpected file type or size')
      const buffer = Buffer.alloc(info.size + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length > info.size) throw new Error('Repository records changed while reading; retry the request')
      text = buffer.subarray(0, length).toString('utf8')
    } finally {
      await handle.close()
    }
    const value = JSON.parse(text) as { version?: unknown; workingDir?: unknown; roots?: unknown; dismissedRoots?: unknown } | null
    if ((value?.version !== 1 && value?.version !== 2) || !isNormalizedPath(value.workingDir) ||
        !isRootList(value.roots, value.workingDir, MAX_ROOTS)) {
      throw new Error('Unexpected repository records format')
    }
    const dismissedRoots = value.version === 1 ? [] : value.dismissedRoots
    if (!isRootList(dismissedRoots, value.workingDir, MAX_DISMISSED_ROOTS) ||
        value.roots.some((root) => dismissedRoots.includes(root))) {
      throw new Error('Unexpected repository records format')
    }
    return value.workingDir === workingDir ? { roots: value.roots, dismissedRoots } : { roots: [], dismissedRoots: [] }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { roots: [], dismissedRoots: [] }
    throw new GitError('GIT_FAILED', `Cannot read saved repositories ${file}: ${(error as Error).message}`)
  }
}

/** Read remembered and dismissed path identities without probing repository directories. */
export async function readRepositoryRecords(spaceId: string, workingDir: string): Promise<RepositoryRecords> {
  if (!isNormalizedPath(workingDir)) throw new GitError('GIT_INVALID_ARGUMENT', 'A normalized absolute working directory is required')
  return readRecords(storeFile(spaceId), workingDir)
}

/** Only explicit opening may restore a dismissed root; obsolete requests never replace records. */
export async function updateRepositoryRecord(
  spaceId: string,
  workingDir: string,
  root: string,
  action: 'discover' | 'open' | 'dismiss',
  isCurrent?: () => boolean,
): Promise<boolean> {
  if (!isNormalizedPath(workingDir) || !isNormalizedPath(root) || !isInside(workingDir, root)) {
    throw new GitError('GIT_INVALID_ARGUMENT', 'A normalized absolute repository root inside the space is required')
  }
  if (action !== 'discover' && action !== 'open' && action !== 'dismiss') {
    throw new GitError('GIT_INVALID_ARGUMENT', 'Unknown repository record action')
  }
  const file = storeFile(spaceId)
  if (pendingWrites >= MAX_PENDING_WRITES || (!writes.has(file) && writes.size >= MAX_PENDING_FILES)) {
    throw new GitError('GIT_BUSY', 'Too many repository record writes are waiting')
  }
  const obsolete = (): boolean => {
    if (!isCurrent || isCurrent()) return false
    console.warn(`[Git] Ignoring obsolete repository ${action} in space ${spaceId}: ${root}`)
    return true
  }
  pendingWrites++
  const previous = writes.get(file) ?? Promise.resolve()
  const next = previous.catch(() => { /* The previous caller receives its failure; this write re-reads the file. */ }).then(async () => {
    if (obsolete()) return false
    requireSpaceIdentity(spaceId, workingDir, file)
    const records = await readRecords(file, workingDir)
    if (obsolete()) return false
    requireSpaceIdentity(spaceId, workingDir, file)
    const remembered = records.roots.includes(root)
    const dismissed = records.dismissedRoots.includes(root)
    if (action === 'discover' && dismissed) {
      console.warn(`[Git] Ignoring discovery of dismissed repository in space ${spaceId}: ${root}`)
      return false
    }
    if (action === 'dismiss' ? dismissed : remembered) return true
    if (action === 'dismiss' && records.dismissedRoots.length >= MAX_DISMISSED_ROOTS) {
      throw new GitError('GIT_FAILED', `At most ${MAX_DISMISSED_ROOTS} repositories can be dismissed in a space`)
    }
    if (action !== 'dismiss' && records.roots.length >= MAX_ROOTS) {
      throw new GitError('GIT_FAILED', `At most ${MAX_ROOTS} repositories can be saved in a space`)
    }
    const content: RepositoryFile = {
      version: 2,
      workingDir,
      roots: action === 'dismiss' ? records.roots.filter((entry) => entry !== root) : [...records.roots, root],
      dismissedRoots: action === 'dismiss' ? [...records.dismissedRoots, root] : records.dismissedRoots.filter((entry) => entry !== root),
    }
    const text = `${JSON.stringify(content, null, 2)}\n`
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) throw new GitError('GIT_FAILED', 'Repository records exceed the file size limit')
    const temporary = `${file}.${randomUUID()}.tmp`
    let temporaryCreated = false
    await mkdir(dirname(file), { recursive: true })
    try {
      const handle = await open(temporary, 'wx', 0o600)
      temporaryCreated = true
      try {
        await handle.writeFile(text)
        await handle.sync()
      } finally {
        await handle.close()
      }
      if (obsolete()) return false
      requireSpaceIdentity(spaceId, workingDir, file)
      await rename(temporary, file)
      temporaryCreated = false
      return true
    } finally {
      if (temporaryCreated) {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') console.warn(`[Git] Cannot remove temporary repository records ${temporary}: ${error.message}`)
        })
      }
    }
  })
  writes.set(file, next)
  try {
    return await next
  } catch (error) {
    if (error instanceof GitError) throw error
    throw new GitError('GIT_FAILED', `Cannot save repositories ${file}: ${(error as Error).message}`)
  } finally {
    pendingWrites--
    if (writes.get(file) === next) writes.delete(file)
  }
}
