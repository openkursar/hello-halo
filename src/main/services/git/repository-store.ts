import { randomUUID } from 'crypto'
import { lstat, mkdir, open, rename, unlink } from 'fs/promises'
import { dirname, isAbsolute, join, resolve } from 'path'
import { getSpace, getSpaceDir } from '../space.service'
import { GitError } from './errors'

const MAX_ROOTS = 64
const MAX_FILE_BYTES = 1024 * 1024
const MAX_PENDING_FILES = 32
const MAX_PENDING_WRITES = 128

interface RepositoryFile {
  version: 1
  workingDir: string
  roots: string[]
}

// Only pending writes are resident; each file's queue disappears when idle.
const writes = new Map<string, Promise<void>>()
let pendingWrites = 0

function storeFile(spaceId: string): string {
  const space = getSpace(spaceId)
  if (!space) throw new GitError('GIT_INVALID_ARGUMENT', `Unknown space: ${spaceId}`)
  return join(space.isTemp ? space.path : join(space.path, '.halo'), 'git', 'repositories.json')
}

async function readRoots(file: string, workingDir: string): Promise<string[]> {
  try {
    const entry = await lstat(file)
    if (!entry.isFile() || entry.size > MAX_FILE_BYTES) throw new Error('Unexpected file type or size')
    const handle = await open(file, 'r')
    let text: string
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('Unexpected file type or size')
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length > MAX_FILE_BYTES) throw new Error('File is too large')
      text = buffer.subarray(0, length).toString('utf8')
    } finally {
      await handle.close()
    }
    const value = JSON.parse(text) as Partial<RepositoryFile> | null
    if (value?.version !== 1 || typeof value.workingDir !== 'string' || !isAbsolute(value.workingDir) ||
        !Array.isArray(value.roots) || value.roots.length > MAX_ROOTS ||
        !value.roots.every((root) => typeof root === 'string' && root.length <= 4096 && !root.includes('\0') && isAbsolute(root) && resolve(root) === root) ||
        new Set(value.roots).size !== value.roots.length) {
      throw new Error('Unexpected repository records format')
    }
    return value.workingDir === workingDir ? value.roots : []
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new GitError('GIT_FAILED', `Cannot read saved repositories ${file}: ${(error as Error).message}`)
  }
}

export function readSavedRepositories(spaceId: string, workingDir: string): Promise<string[]> {
  return readRoots(storeFile(spaceId), workingDir)
}

export async function updateSavedRepository(spaceId: string, workingDir: string, root: string, save: boolean): Promise<void> {
  const file = storeFile(spaceId)
  if (pendingWrites >= MAX_PENDING_WRITES || (!writes.has(file) && writes.size >= MAX_PENDING_FILES)) {
    throw new GitError('GIT_BUSY', 'Too many repository record writes are waiting')
  }
  pendingWrites++
  const previous = writes.get(file) ?? Promise.resolve()
  const next = previous.catch(() => { /* The previous caller receives its failure; this write re-reads the file. */ }).then(async () => {
    const currentDir = getSpaceDir(spaceId)
    if (!currentDir || resolve(currentDir) !== workingDir) {
      throw new GitError('GIT_INVALID_ARGUMENT', 'The space working directory changed; retry the repository selection')
    }
    const roots = await readRoots(file, workingDir)
    if (roots.includes(root) === save) return
    if (save && roots.length >= MAX_ROOTS) throw new GitError('GIT_FAILED', `At most ${MAX_ROOTS} repositories can be saved in a space`)
    const content: RepositoryFile = { version: 1, workingDir, roots: save ? [...roots, root] : roots.filter((entry) => entry !== root) }
    const temporary = `${file}.${randomUUID()}.tmp`
    await mkdir(dirname(file), { recursive: true })
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(content, null, 2)}\n`)
      } finally {
        await handle.close()
      }
      const latestDir = getSpaceDir(spaceId)
      if (!latestDir || resolve(latestDir) !== workingDir || storeFile(spaceId) !== file) {
        throw new GitError('GIT_INVALID_ARGUMENT', 'The space changed while saving repositories; retry the selection')
      }
      await rename(temporary, file)
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') console.warn(`[Git] Cannot remove temporary repository records ${temporary}: ${error.message}`)
      })
    }
  })
  writes.set(file, next)
  try {
    await next
  } catch (error) {
    if (error instanceof GitError) throw error
    throw new GitError('GIT_FAILED', `Cannot save repositories ${file}: ${(error as Error).message}`)
  } finally {
    pendingWrites--
    if (writes.get(file) === next) writes.delete(file)
  }
}
