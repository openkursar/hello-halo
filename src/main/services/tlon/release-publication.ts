import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getKBDir, getKBHashesPath, getKBIndexMdPath, getKBIngestDir, getKBRetainedDir, getKBTextDir } from './paths'

type Entry = { name: string; existed: boolean }
const documentName = /^[0-9a-f]{16}\.txt$/
const retainedName = /^retained\/[0-9a-f]{16}(?:-\d+)?\.txt$/
const retainedBackupName = /^retained-[0-9a-f]{16}(?:-\d+)?\.txt$/
const backupName = (name: string) => name.replace('/', '-')

function target(kbId: string, name: string): string {
  if (name === 'hashes.json') return getKBHashesPath(kbId)
  if (name === 'index.md') return getKBIndexMdPath(kbId)
  if (retainedName.test(name)) {
    assertDirectory(getKBRetainedDir(kbId))
    return join(getKBIngestDir(kbId), name)
  }
  if (!documentName.test(name)) throw new Error('Invalid knowledge release file')
  return join(getKBTextDir(kbId), name)
}

function publicationDir(kbId: string): string {
  return join(getKBIngestDir(kbId), 'publication')
}

function assertDirectory(path: string): void {
  if (!lstatSync(path).isDirectory()) throw new Error('Knowledge release directory is not owned')
}

/** An intent survives until the map, records and changed text have all been published. Backups are hard links, not copies of the corpus. */
export function publishRelease(kbId: string, names: Iterable<string>, publish: () => void): void {
  const dir = publicationDir(kbId)
  const intent = join(dir, 'pending.json')
  assertDirectory(getKBDir(kbId))
  assertDirectory(getKBIngestDir(kbId))
  if (existsSync(dir)) recoverPublication(kbId)
  assertDirectory(getKBTextDir(kbId))
  mkdirSync(dir)
  try {
    const entries: Entry[] = []
    for (const name of new Set([...names, 'hashes.json', 'index.md'])) {
      const path = target(kbId, name)
      const stat = lstatSync(path, { throwIfNoEntry: false })
      if (stat && !stat.isFile()) throw new Error('Cannot replace non-regular knowledge release file')
      if (stat) linkSync(path, join(dir, backupName(name)))
      entries.push({ name, existed: !!stat })
    }
    writeFileSync(join(dir, 'prepared.json'), JSON.stringify(entries), { flag: 'wx' })
    renameSync(join(dir, 'prepared.json'), intent)
    publish()
    rmSync(intent)
  } catch (error) {
    recoverPublication(kbId)
    throw error
  }
  removeBackups(kbId, dir)
}

function removeBackups(kbId: string, dir: string): void {
  try {
    const files = readdirSync(dir, { withFileTypes: true })
    if (files.some(f => !f.isFile() || (!documentName.test(f.name) && !retainedBackupName.test(f.name) &&
        !['index.md', 'hashes.json', 'restoring', 'prepared.json'].includes(f.name)))) {
      throw new Error('Unrecognized release backup; leaving it in place')
    }
    for (const file of files) rmSync(join(dir, file.name))
    rmdirSync(dir)
  } catch (error) { console.warn(`[Tlon] Could not clear release backups for ${kbId}:`, error) }
}

/** Backups remain in place throughout rollback, so interrupted recovery can be repeated. */
export function recoverPublication(kbId: string): void {
  const dir = publicationDir(kbId)
  if (!existsSync(dir)) return
  assertDirectory(getKBDir(kbId))
  assertDirectory(getKBIngestDir(kbId))
  assertDirectory(dir)
  const intent = join(dir, 'pending.json')
  if (existsSync(intent)) {
    assertDirectory(getKBTextDir(kbId))
    if (!lstatSync(intent).isFile()) throw new Error('Invalid knowledge release intent')
    const entries: Entry[] = JSON.parse(readFileSync(intent, 'utf8'))
    for (const { name, existed } of entries) {
      const path = target(kbId, name)
      if (existed === false) rmSync(path, { force: true })
      else {
        const backup = join(dir, backupName(name))
        if (existed !== true || !lstatSync(backup).isFile()) throw new Error('Invalid knowledge release backup')
        const tmp = join(dir, 'restoring')
        rmSync(tmp, { force: true })
        linkSync(backup, tmp)
        renameSync(tmp, path)
      }
    }
    rmSync(intent)
    console.warn(`[Tlon] Restored the previous knowledge release for ${kbId}`)
  }
  removeBackups(kbId, dir)
}
