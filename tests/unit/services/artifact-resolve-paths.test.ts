/**
 * Which file mentions in an AI reply name real files of the space. The paths
 * come from model output, so the service must answer only about the space's
 * own files and must not even touch the filesystem for a path outside it —
 * a network share is reached merely by asking about it. Bounded in count,
 * one lookup per path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const env = vi.hoisted(() => ({ workDir: '' }))
vi.mock('../../../src/main/services/space.service', () => ({
  getSpace: (id: string) => (id === 'space-a' ? { id, path: env.workDir, workingDir: env.workDir } : null),
  getSpaceDir: (id: string) => (id === 'space-a' ? env.workDir : ''),
}))
vi.mock('../../../src/main/services/watcher-host.service', () => ({ queryFilesViaWorker: vi.fn() }))
vi.mock('../../../src/main/services/artifact-cache.service', () => ({}))

import { MAX_RESOLVED_PATHS, resolveArtifactPaths } from '../../../src/main/services/artifact.service'

let root: string
let outside: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'halo-resolve-')))
  env.workDir = path.join(root, 'space')
  outside = path.join(root, 'elsewhere')
  fs.mkdirSync(path.join(env.workDir, 'src', 'nested'), { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(env.workDir, 'src', 'a.ts'), 'export {}\n')
  fs.writeFileSync(path.join(env.workDir, 'src', 'nested', 'b.ts'), 'export {}\n')
  fs.writeFileSync(path.join(env.workDir, 'README.md'), '# hi\n')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'no\n')
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

const found = (results: Awaited<ReturnType<typeof resolveArtifactPaths>>) =>
  Object.fromEntries(results.map(r => [r.path, r.absolutePath]))

describe('resolveArtifactPaths', () => {
  it('resolves relative paths against the working directory and keeps the order asked', async () => {
    const results = await resolveArtifactPaths('space-a', ['src/a.ts', 'README.md', 'src/missing.ts'])
    expect(results.map(r => r.path)).toEqual(['src/a.ts', 'README.md', 'src/missing.ts'])
    expect(found(results)).toEqual({
      'src/a.ts': path.join(env.workDir, 'src', 'a.ts'),
      'README.md': path.join(env.workDir, 'README.md'),
      'src/missing.ts': null,
    })
  })

  it('answers for absolute paths inside the space, and tells folders apart', async () => {
    const results = await resolveArtifactPaths('space-a', [path.join(env.workDir, 'src', 'a.ts'), path.join(env.workDir, 'src')])
    expect(results[0]).toMatchObject({ absolutePath: path.join(env.workDir, 'src', 'a.ts'), isDirectory: false })
    expect(results[1]).toMatchObject({ absolutePath: path.join(env.workDir, 'src'), isDirectory: true })
  })

  it('resolves against a base directory inside the space (a nested repository)', async () => {
    const results = await resolveArtifactPaths('space-a', ['nested/b.ts', 'a.ts'], path.join(env.workDir, 'src'))
    expect(found(results)).toEqual({
      'nested/b.ts': path.join(env.workDir, 'src', 'nested', 'b.ts'),
      'a.ts': path.join(env.workDir, 'src', 'a.ts'),
    })
  })

  it('falls back to the working directory when the base directory lies outside the space', async () => {
    const results = await resolveArtifactPaths('space-a', ['secret.txt', 'README.md'], outside)
    expect(found(results)).toEqual({ 'secret.txt': null, 'README.md': path.join(env.workDir, 'README.md') })
  })

  it('never answers for a path that leaves the space, by `..`, by an absolute path or through a link', async () => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(env.workDir, 'link.txt'))
    const results = await resolveArtifactPaths('space-a', [
      '../elsewhere/secret.txt',
      path.join(outside, 'secret.txt'),
      'link.txt',
      'src/../../elsewhere/secret.txt',
    ])
    expect(results.every(r => r.absolutePath === null)).toBe(true)
  })

  it('does not touch the filesystem for a path that is outside the space as written', async () => {
    const realpath = vi.spyOn(fs.promises, 'realpath')
    const stat = vi.spyOn(fs.promises, 'stat')
    const results = await resolveArtifactPaths('space-a', [
      '../elsewhere/secret.txt',
      path.join(outside, 'secret.txt'),
      '\\\\attacker.example\\share\\x.ts',
      '//attacker.example/share/x.ts',
      '\\\\?\\C:\\Windows\\win.ini',
      '\\\\.\\PhysicalDrive0',
      'C:relative.ts',
    ])
    expect(results.every(r => r.absolutePath === null)).toBe(true)
    // Only the space root itself is resolved once; no asked path reaches the filesystem.
    expect(realpath.mock.calls.map(([p]) => String(p))).toEqual([path.resolve(env.workDir)])
    expect(stat).not.toHaveBeenCalled()
  })

  it('refuses a network or drive-relative base directory', async () => {
    const realpath = vi.spyOn(fs.promises, 'realpath')
    const results = await resolveArtifactPaths('space-a', ['README.md'], '\\\\attacker.example\\share')
    expect(found(results)).toEqual({ 'README.md': path.join(env.workDir, 'README.md') })
    expect(realpath.mock.calls.some(([p]) => String(p).includes('attacker'))).toBe(false)
  })

  it('answers nothing for an unknown space, without falling back to another directory', async () => {
    const stat = vi.spyOn(fs.promises, 'stat')
    const results = await resolveArtifactPaths('space-b', [path.join(env.workDir, 'README.md'), 'README.md'])
    expect(results.every(r => r.absolutePath === null)).toBe(true)
    expect(stat).not.toHaveBeenCalled()
  })

  it('is bounded: at most MAX_RESOLVED_PATHS answers, absurd entries refused and non-strings dropped', async () => {
    const many = Array.from({ length: MAX_RESOLVED_PATHS + 25 }, (_, i) => `src/file-${i}.ts`)
    expect(await resolveArtifactPaths('space-a', many)).toHaveLength(MAX_RESOLVED_PATHS)
    const results = await resolveArtifactPaths('space-a', ['', 'x'.repeat(5000), 42 as unknown as string, { path: 'a' } as unknown as string])
    expect(results.map(r => r.path)).toEqual(['', 'x'.repeat(5000)])
    expect(results.every(r => r.absolutePath === null)).toBe(true)
  })
})
