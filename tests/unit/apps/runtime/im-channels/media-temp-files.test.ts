/**
 * Unit tests for apps/runtime/im-channels/media-temp-files.
 *
 * Covers the two guarantees adapters rely on:
 *   - a wire-supplied filename cannot escape the staging directory
 *   - pruning removes only files past the age cutoff, and tolerates a
 *     missing directory
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import {
  stageMediaFile,
  pruneMediaTempDir,
} from '../../../../../src/main/apps/runtime/im-channels/media-temp-files'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'halo-media-temp-test-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('stageMediaFile', () => {
  it('writes the payload and returns its path', async () => {
    const dir = join(root, 'staged')
    const staged = await stageMediaFile(dir, 'report.pdf', Buffer.from('payload'))

    expect(dirname(staged.localPath)).toBe(dir)
    expect(readFileSync(staged.localPath).toString()).toBe('payload')
    expect(staged.filename).toBe('report.pdf')
  })

  it('keeps a traversal-shaped name inside the staging directory', async () => {
    const dir = join(root, 'staged')
    const staged = await stageMediaFile(dir, '../../escape.sh', Buffer.alloc(1))

    expect(staged.filename).toBe('escape.sh')
    expect(dirname(staged.localPath)).toBe(dir)
    expect(existsSync(join(root, 'escape.sh'))).toBe(false)
  })

  it('does not overwrite an earlier file of the same name', async () => {
    const dir = join(root, 'staged')
    const first = await stageMediaFile(dir, 'photo.jpg', Buffer.from('one'))
    const second = await stageMediaFile(dir, 'photo.jpg', Buffer.from('two'))

    expect(second.localPath).not.toBe(first.localPath)
    expect(readFileSync(first.localPath).toString()).toBe('one')
    expect(basename(first.localPath).endsWith('photo.jpg')).toBe(true)
  })

  // Permission bits are POSIX-only; on Windows fs modes are advisory.
  it.skipIf(process.platform === 'win32')(
    'restricts the staging dir and file to the owner',
    async () => {
      const dir = join(root, 'staged')
      const staged = await stageMediaFile(dir, 'secret.png', Buffer.from('bytes'))

      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(statSync(staged.localPath).mode & 0o777).toBe(0o600)
    },
  )

  it.skipIf(process.platform === 'win32')(
    'tightens a pre-existing staging dir created with looser modes',
    async () => {
      const dir = join(root, 'staged')
      mkdirSync(dir, { recursive: true, mode: 0o755 })

      await stageMediaFile(dir, 'a.bin', Buffer.alloc(1))
      expect(statSync(dir).mode & 0o777).toBe(0o700)
    },
  )

  it('prunes expired files when given a max age, keeping the fresh ones', async () => {
    const dir = join(root, 'staged')
    const old = await stageMediaFile(dir, 'old.bin', Buffer.alloc(1))
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000)
    utimesSync(old.localPath, longAgo, longAgo)
    const fresh = await stageMediaFile(dir, 'fresh.bin', Buffer.alloc(1))

    const next = await stageMediaFile(dir, 'next.bin', Buffer.alloc(1), 24 * 60 * 60 * 1000)

    expect(existsSync(old.localPath)).toBe(false)
    expect(existsSync(fresh.localPath)).toBe(true)
    expect(existsSync(next.localPath)).toBe(true)
  })

  it('does not prune when no max age is given', async () => {
    const dir = join(root, 'staged')
    const old = await stageMediaFile(dir, 'old.bin', Buffer.alloc(1))
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000)
    utimesSync(old.localPath, longAgo, longAgo)

    await stageMediaFile(dir, 'next.bin', Buffer.alloc(1))
    expect(existsSync(old.localPath)).toBe(true)
  })
})

describe('pruneMediaTempDir', () => {
  it('removes only files older than the cutoff', () => {
    const dir = join(root, 'staged')
    mkdirSync(dir, { recursive: true })
    const stale = join(dir, 'stale.bin')
    const fresh = join(dir, 'fresh.bin')
    writeFileSync(stale, 'x')
    writeFileSync(fresh, 'x')
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000)
    utimesSync(stale, longAgo, longAgo)

    expect(pruneMediaTempDir(dir, 24 * 60 * 60 * 1000)).toBe(1)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('treats a missing directory as nothing to do', () => {
    expect(pruneMediaTempDir(join(root, 'never-created'), 1000)).toBe(0)
  })
})
