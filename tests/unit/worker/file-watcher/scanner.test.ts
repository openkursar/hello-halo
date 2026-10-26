/**
 * A directory that cannot be read is not an empty directory. The scanner used
 * to swallow the read error and answer with no entries, which the tree cache
 * then applied as "everything in it was deleted" (#458). A failed read now
 * rejects with its OS code, so the cache can tell a directory that is not
 * there (ENOENT) from one that cannot be read right now.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs, { promises as fsp } from 'fs'
import os from 'os'
import path from 'path'
import { scanDirectoryTreeShallow, loadTreeIgnoreRules } from '../../../../src/worker/file-watcher/scanner'

let root: string
const scan = (dir: string) => scanDirectoryTreeShallow(dir, root, 0, loadTreeIgnoreRules())

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-scan-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('scanDirectoryTreeShallow', () => {
  it('lists folders first and leaves out hidden system files', async () => {
    fs.writeFileSync(path.join(root, 'b.txt'), '')
    fs.writeFileSync(path.join(root, '.DS_Store'), '')
    fs.mkdirSync(path.join(root, 'z-dir'))
    expect((await scan(root)).map(n => [n.name, n.type])).toEqual([['z-dir', 'folder'], ['b.txt', 'file']])
  })

  it('lists an empty directory as empty', async () => {
    await expect(scan(root)).resolves.toEqual([])
  })

  it('rejects with ENOENT for a directory that is not there', async () => {
    await expect(scan(path.join(root, 'gone'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['EACCES', 'EBUSY'])('rejects with %s when the directory cannot be read', async (code) => {
    fs.writeFileSync(path.join(root, 'a.txt'), '')
    vi.spyOn(fsp, 'readdir').mockRejectedValueOnce(Object.assign(new Error(`${code}: scandir '${root}'`), { code }))
    await expect(scan(root)).rejects.toMatchObject({ code })
  })
})
