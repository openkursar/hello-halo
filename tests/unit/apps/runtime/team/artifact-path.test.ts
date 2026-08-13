/**
 * Unit tests for the published-ref rule (runtime/team artifact-path): which
 * paths a member may publish, and what portable form gets stored.
 *
 * Proven:
 *   - a relative ref resolves and is stored unchanged;
 *   - an absolute path INSIDE the work dir is folded back to its relative form,
 *     because that is the only form that means anything on a teammate's machine;
 *   - a path outside the work dir is refused, including via traversal and via a
 *     symlink that sits inside but points out;
 *   - a missing file and a directory are refused with distinct reasons, so the
 *     publisher is told what is actually wrong;
 *   - every rejection names the work dir and offers a way forward — the guidance
 *     is what stops a member from re-publishing the same broken ref in a loop.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  resolveArtifactRef,
  explainArtifactRefRejection,
  formatArtifactSize,
} from '../../../../../src/main/apps/runtime/team/artifact-path'

describe('artifact-path', () => {
  let root: string
  let workDir: string
  let outside: string

  beforeEach(() => {
    // realpath up front: macOS hands out /var/... for a /private/var/... temp
    // dir, and resolution reports the real path.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'halo-artifact-path-')))
    workDir = join(root, 'project')
    outside = join(root, 'elsewhere')
    mkdirSync(workDir)
    mkdirSync(outside)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('accepts a relative ref and stores it unchanged', () => {
    mkdirSync(join(workDir, 'docs'))
    writeFileSync(join(workDir, 'docs', 'design.md'), 'hello')

    const res = resolveArtifactRef(workDir, 'docs/design.md')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.ref).toBe('docs/design.md')
    expect(res.absPath).toBe(join(workDir, 'docs', 'design.md'))
    expect(res.bytes).toBe(5)
  })

  it('folds an absolute path inside the work dir back to a relative ref', () => {
    mkdirSync(join(workDir, 'docs'))
    writeFileSync(join(workDir, 'docs', 'design.md'), 'hello')

    const res = resolveArtifactRef(workDir, join(workDir, 'docs', 'design.md'))
    expect(res.ok).toBe(true)
    // Stored relative: the same project sits elsewhere on every other machine.
    if (res.ok) expect(res.ref).toBe('docs/design.md')
  })

  it('normalizes a leading "./" and redundant segments', () => {
    writeFileSync(join(workDir, 'notes.md'), 'x')

    const res = resolveArtifactRef(workDir, './docs/../notes.md')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.ref).toBe('notes.md')
  })

  it('refuses an absolute path outside the work dir', () => {
    writeFileSync(join(outside, 'secret.md'), 'x')

    const res = resolveArtifactRef(workDir, join(outside, 'secret.md'))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('outside-work-dir')
  })

  it('refuses traversal out of the work dir', () => {
    writeFileSync(join(outside, 'secret.md'), 'x')

    const res = resolveArtifactRef(workDir, '../elsewhere/secret.md')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('outside-work-dir')
  })

  it('refuses a symlink that sits inside the work dir but points outside it', () => {
    writeFileSync(join(outside, 'secret.md'), 'x')
    symlinkSync(join(outside, 'secret.md'), join(workDir, 'link.md'))

    const res = resolveArtifactRef(workDir, 'link.md')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('outside-work-dir')
  })

  it('refuses a missing file and a directory with distinct reasons', () => {
    mkdirSync(join(workDir, 'docs'))

    const missing = resolveArtifactRef(workDir, 'docs/nope.md')
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.reason).toBe('missing')

    const dir = resolveArtifactRef(workDir, 'docs')
    expect(dir.ok).toBe(false)
    if (!dir.ok) expect(dir.reason).toBe('not-a-file')
  })

  it('refuses an empty ref and an unknown work dir', () => {
    const empty = resolveArtifactRef(workDir, '   ')
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.reason).toBe('empty')

    const noRoot = resolveArtifactRef('', 'notes.md')
    expect(noRoot.ok).toBe(false)
    if (!noRoot.ok) expect(noRoot.reason).toBe('no-work-dir')
  })

  it.each(['empty', 'outside-work-dir', 'missing', 'not-a-file'] as const)(
    'explains a %s rejection with the work dir and a way forward',
    (reason) => {
      const msg = explainArtifactRefRejection(reason, { ref: 'x.md', workDir })
      expect(msg).toContain(workDir)
      expect(msg.toLowerCase()).toContain('working directory')
      expect(msg).toContain('share the content')
    }
  )

  it('formats sizes for the publish receipt', () => {
    expect(formatArtifactSize(512)).toBe('512 B')
    expect(formatArtifactSize(2048)).toBe('2.0 KB')
    expect(formatArtifactSize(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})
