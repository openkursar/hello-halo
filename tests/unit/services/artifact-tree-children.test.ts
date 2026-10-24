/**
 * Listing a folder for the file tree. The tree replaces a folder's children
 * with the listing it receives, so a folder that cannot be read right now must
 * come back as a failure — the tree then keeps what it shows — never as an
 * empty listing that wipes it (#458).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const env = vi.hoisted(() => ({ workDir: '', loadDirectoryChildren: vi.fn() }))
vi.mock('../../../src/main/services/space.service', () => ({
  getSpace: (id: string) => (id === 'space-a' ? { id, path: env.workDir, workingDir: env.workDir } : null),
  getSpaceDir: (id: string) => (id === 'space-a' ? env.workDir : ''),
}))
vi.mock('../../../src/main/services/watcher-host.service', () => ({ queryFilesViaWorker: vi.fn() }))
vi.mock('../../../src/main/services/artifact-cache.service', () => ({
  loadDirectoryChildren: (...args: unknown[]) => env.loadDirectoryChildren(...args),
}))

import { loadTreeChildren } from '../../../src/main/services/artifact.service'

let root: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'halo-children-')))
  env.workDir = root
  env.loadDirectoryChildren.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('loadTreeChildren', () => {
  it('fails when the folder cannot be read instead of answering with no children', async () => {
    env.loadDirectoryChildren.mockRejectedValueOnce(Object.assign(new Error(`EACCES: permission denied, scandir '${root}'`), { code: 'EACCES' }))
    await expect(loadTreeChildren('space-a', root)).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('answers an empty folder with no children', async () => {
    env.loadDirectoryChildren.mockResolvedValueOnce([])
    await expect(loadTreeChildren('space-a', root)).resolves.toEqual([])
  })
})
