/**
 * A client path stays inside the working tree: no absolute paths, no `..`,
 * nothing under `.git`, no way out through a symlinked directory.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { assertRepoPath, assertRepoPathList, chunkPaths, resolveWorktreePath } from '../../../../src/main/services/git/paths'
import { makeTempDir } from './_repo'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('assertRepoPath', () => {
  it('accepts normalized repository paths, spaces and CJK included', () => {
    for (const path of ['a.txt', 'src/main/x.ts', 'dir with space/文件.md', 'a*b[1].ts', ':colon.txt', '.gitignore', 'x/.github/ci.yml']) {
      expect(assertRepoPath(path)).toBe(path)
    }
  })

  it.each([
    ['', 'empty'],
    ['/etc/passwd', 'absolute'],
    ['C:/Windows/system.ini', 'drive'],
    ['../outside.txt', 'parent'],
    ['src/../../outside.txt', 'nested parent'],
    ['./a.txt', 'dot segment'],
    ['src//a.txt', 'empty segment'],
    ['src/', 'trailing slash'],
    ['.git/config', 'git dir'],
    ['sub/.GIT/config', 'git dir, case folded'],
    ['a\0b', 'NUL'],
  ])('rejects %j (%s)', (path) => {
    expect(() => assertRepoPath(path)).toThrowError(expect.objectContaining({ code: 'GIT_INVALID_ARGUMENT' }))
  })

  it('rejects names some file system opens as .git', () => {
    expect(() => assertRepoPath('.g\u200Cit/config')).toThrowError(expect.objectContaining({ code: 'GIT_INVALID_ARGUMENT' }))
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      for (const path of ['.git./config', '.git /config', 'GIT~1/config', '.git::$INDEX_ALLOCATION/config', 'a\\b.txt']) {
        expect(() => assertRepoPath(path)).toThrowError(expect.objectContaining({ code: 'GIT_INVALID_ARGUMENT' }))
      }
      expect(assertRepoPath('src/gitx.ts')).toBe('src/gitx.ts')
    } finally {
      platform.mockRestore()
    }
  })

  it('rejects non-strings and bounds lists', () => {
    expect(() => assertRepoPath(42)).toThrowError(expect.objectContaining({ code: 'GIT_INVALID_ARGUMENT' }))
    expect(() => assertRepoPathList([])).toThrowError(expect.objectContaining({ code: 'GIT_INVALID_ARGUMENT' }))
    expect(assertRepoPathList(['a', 'b', 'a'])).toEqual(['a', 'b'])
  })
})

describe('resolveWorktreePath', () => {
  it('resolves inside the tree and refuses a symlinked directory that leads out', async () => {
    const base = makeTempDir()
    dirs.push(base)
    const root = join(base, 'repo')
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(base, 'outside'))
    writeFileSync(join(base, 'outside', 'secret.txt'), 'secret')
    symlinkSync(join(base, 'outside'), join(root, 'escape'))
    symlinkSync(join(root, 'src'), join(root, 'alias'))

    expect(await resolveWorktreePath(root, 'src/a.ts')).toBe(join(root, 'src', 'a.ts'))
    expect(await resolveWorktreePath(root, 'alias/a.ts')).toBe(join(root, 'alias', 'a.ts'))
    expect(await resolveWorktreePath(root, 'missing-dir/a.ts')).toBeNull()
    await expect(resolveWorktreePath(root, 'escape/secret.txt')).rejects.toMatchObject({ code: 'GIT_INVALID_ARGUMENT' })
  })
})

describe('chunkPaths', () => {
  it('keeps every batch under the length budget and loses nothing', () => {
    const paths = Array.from({ length: 50 }, (_, i) => `dir/file-${i}.ts`)
    const chunks = chunkPaths(paths, 100)
    expect(chunks.flat()).toEqual(paths)
    for (const chunk of chunks) expect(chunk.join(' ').length).toBeLessThanOrEqual(100)
  })
})
