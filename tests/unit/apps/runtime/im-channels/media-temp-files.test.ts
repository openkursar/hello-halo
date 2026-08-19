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
