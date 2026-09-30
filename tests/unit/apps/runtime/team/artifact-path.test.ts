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
 *     is what stops a member from re-publishing the same broken ref in a loop;
 *   - a file in the member's own team folder publishes as `team:<folder>/<path>`,
 *     given as an absolute path or as the ref itself;
 *   - a file in a teammate's part of the team folder is refused, so a `team:` ref
 *     always names its real producer;
 *   - escaping the team folder by `..` or by a symlink is refused;
 *   - a working directory wide enough to contain the team folder does not claim it;
 *   - the read side resolves any member's `team:` file but never a path outside
 *     the folder, and never mistakes a `team:` ref for a project path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  resolveArtifactRef,
  resolvePublishedRef,
  explainArtifactRefRejection,
  formatArtifactSize,
} from '../../../../../src/main/apps/runtime/team/artifact-path'
import type { TeamFolderPaths } from '../../../../../src/main/apps/runtime/team/team-folder'

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

    const res = resolveArtifactRef({ workDir, teamFolder: null }, 'docs/design.md')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.ref).toBe('docs/design.md')
    expect(res.absPath).toBe(join(workDir, 'docs', 'design.md'))
    expect(res.bytes).toBe(5)
  })

  it('folds an absolute path inside the work dir back to a relative ref', () => {
    mkdirSync(join(workDir, 'docs'))
    writeFileSync(join(workDir, 'docs', 'design.md'), 'hello')

    const res = resolveArtifactRef({ workDir, teamFolder: null }, join(workDir, 'docs', 'design.md'))
    expect(res.ok).toBe(true)
    // Stored relative: the same project sits elsewhere on every other machine.
    if (res.ok) expect(res.ref).toBe('docs/design.md')
  })

  it('normalizes a leading "./" and redundant segments', () => {
    writeFileSync(join(workDir, 'notes.md'), 'x')

    const res = resolveArtifactRef({ workDir, teamFolder: null }, './docs/../notes.md')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.ref).toBe('notes.md')
  })

  it('refuses an absolute path outside the work dir', () => {
    writeFileSync(join(outside, 'secret.md'), 'x')

    const res = resolveArtifactRef({ workDir, teamFolder: null }, join(outside, 'secret.md'))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('outside-work-dir')
  })

  it('refuses traversal out of the work dir', () => {
    writeFileSync(join(outside, 'secret.md'), 'x')

    const res = resolveArtifactRef({ workDir, teamFolder: null }, '../elsewhere/secret.md')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('outside-work-dir')
  })

  it('refuses a symlink that sits inside the work dir but points outside it', () => {
    writeFileSync(join(outside, 'secret.md'), 'x')
    symlinkSync(join(outside, 'secret.md'), join(workDir, 'link.md'))

    const res = resolveArtifactRef({ workDir, teamFolder: null }, 'link.md')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('outside-work-dir')
  })

  it('refuses a missing file and a directory with distinct reasons', () => {
    mkdirSync(join(workDir, 'docs'))

    const missing = resolveArtifactRef({ workDir, teamFolder: null }, 'docs/nope.md')
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.reason).toBe('missing')

    const dir = resolveArtifactRef({ workDir, teamFolder: null }, 'docs')
    expect(dir.ok).toBe(false)
    if (!dir.ok) expect(dir.reason).toBe('not-a-file')
  })

  it('refuses an empty ref and an unknown work dir', () => {
    const empty = resolveArtifactRef({ workDir, teamFolder: null }, '   ')
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.reason).toBe('empty')

    const noRoot = resolveArtifactRef({ workDir: '', teamFolder: null }, 'notes.md')
    expect(noRoot.ok).toBe(false)
    if (!noRoot.ok) expect(noRoot.reason).toBe('no-work-dir')
  })

  it.each(['empty', 'outside-work-dir', 'missing', 'not-a-file'] as const)(
    'explains a %s rejection with the work dir and a way forward',
    (reason) => {
      const msg = explainArtifactRefRejection(reason, { ref: 'x.md', workDir, teamFolder: null })
      expect(msg).toContain(workDir)
      expect(msg.toLowerCase()).toContain('working directory')
      expect(msg).toContain('share the content')
    }
  )

  describe('team folder', () => {
    let folder: TeamFolderPaths
    let peerDir: string

    beforeEach(() => {
      const shared = join(root, 'team-work', 'abc123def456')
      folder = { shared, self: join(shared, 'reviewer') }
      peerDir = join(shared, 'writer')
      mkdirSync(folder.self, { recursive: true })
      mkdirSync(peerDir, { recursive: true })
    })

    it('publishes an absolute path in the own folder as a team ref', () => {
      writeFileSync(join(folder.self, 'review.md'), 'looks good')

      const res = resolveArtifactRef({ workDir, teamFolder: folder }, join(folder.self, 'review.md'))
      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.ref).toBe('team:reviewer/review.md')
      expect(res.absPath).toBe(join(folder.self, 'review.md'))
      expect(res.bytes).toBe(10)
    })

    it('accepts the team ref itself, including nested paths', () => {
      mkdirSync(join(folder.self, 'round-1'))
      writeFileSync(join(folder.self, 'round-1', 'notes.md'), 'x')

      const res = resolveArtifactRef({ workDir, teamFolder: folder }, 'team:reviewer/round-1/notes.md')
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.ref).toBe('team:reviewer/round-1/notes.md')
    })

    it('refuses a teammate\u2019s file, however it is named', () => {
      writeFileSync(join(peerDir, 'draft.md'), 'x')

      for (const ref of [join(peerDir, 'draft.md'), 'team:writer/draft.md', 'team:reviewer/../writer/draft.md']) {
        const res = resolveArtifactRef({ workDir, teamFolder: folder }, ref)
        expect(res.ok).toBe(false)
        if (!res.ok) expect(res.reason).toBe('other-member-folder')
      }
    })

    it('refuses a file sitting directly in the shared folder', () => {
      writeFileSync(join(folder.shared, 'loose.md'), 'x')

      const abs = resolveArtifactRef({ workDir, teamFolder: folder }, join(folder.shared, 'loose.md'))
      expect(abs.ok).toBe(false)
      if (!abs.ok) expect(abs.reason).toBe('other-member-folder')
      const ref = resolveArtifactRef({ workDir, teamFolder: folder }, 'team:loose.md')
      expect(ref.ok).toBe(false)
      if (!ref.ok) expect(ref.reason).toBe('outside-work-dir')
    })

    it('refuses escaping the team folder by traversal or symlink', () => {
      writeFileSync(join(outside, 'secret.md'), 'x')
      symlinkSync(join(outside, 'secret.md'), join(folder.self, 'link.md'))

      for (const ref of ['team:reviewer/../../../elsewhere/secret.md', 'team:reviewer/link.md', 'team:/etc/passwd']) {
        const res = resolveArtifactRef({ workDir, teamFolder: folder }, ref)
        expect(res.ok).toBe(false)
        if (!res.ok) expect(['outside-work-dir', 'other-member-folder']).toContain(res.reason)
      }
    })

    it('prefers the team folder when the working directory contains it', () => {
      writeFileSync(join(folder.self, 'review.md'), 'x')

      const res = resolveArtifactRef({ workDir: root, teamFolder: folder }, join(folder.self, 'review.md'))
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.ref).toBe('team:reviewer/review.md')
    })

    it('still publishes working-directory files by their relative path', () => {
      writeFileSync(join(workDir, 'CHANGELOG.md'), 'x')

      const res = resolveArtifactRef({ workDir, teamFolder: folder }, 'CHANGELOG.md')
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.ref).toBe('CHANGELOG.md')
    })

    it('finds a bare path in the own team folder when the project lacks it', () => {
      writeFileSync(join(folder.self, 'review.md'), 'x')

      for (const ref of ['review.md', 'reviewer/review.md']) {
        const res = resolveArtifactRef({ workDir, teamFolder: folder }, ref)
        expect(res.ok).toBe(true)
        if (res.ok) expect(res.ref).toBe('team:reviewer/review.md')
      }
    })

    it('keeps a bare path in the project when the project has the file', () => {
      writeFileSync(join(folder.self, 'review.md'), 'team copy')
      writeFileSync(join(workDir, 'review.md'), 'project copy')

      const res = resolveArtifactRef({ workDir, teamFolder: folder }, 'review.md')
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.ref).toBe('review.md')
    })

    it('never falls back into a teammate\u2019s folder', () => {
      writeFileSync(join(peerDir, 'draft.md'), 'x')

      const res = resolveArtifactRef({ workDir, teamFolder: folder }, 'writer/draft.md')
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toBe('missing')
    })

    it('refuses a team ref from a member with no team folder', () => {
      const res = resolveArtifactRef({ workDir, teamFolder: null }, 'team:reviewer/review.md')
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toBe('no-team-folder')
    })

    it('reads any member\u2019s team file, but nothing outside the folder', () => {
      writeFileSync(join(peerDir, 'draft.md'), 'x')
      writeFileSync(join(outside, 'secret.md'), 'x')

      const ok = resolvePublishedRef({ workDir: null, teamFolder: folder.shared }, 'team:writer/draft.md')
      expect(ok.ok).toBe(true)
      if (ok.ok) expect(ok.absPath).toBe(join(peerDir, 'draft.md'))

      const escaped = resolvePublishedRef({ workDir: null, teamFolder: folder.shared }, 'team:writer/../../../elsewhere/secret.md')
      expect(escaped.ok).toBe(false)
    })

    it('never resolves a team ref as a project path', () => {
      // A file literally named like the ref inside the project must not be what a reader gets.
      mkdirSync(join(workDir, 'team:writer'), { recursive: true })
      writeFileSync(join(workDir, 'team:writer', 'draft.md'), 'project file')

      const res = resolvePublishedRef({ workDir, teamFolder: null }, 'team:writer/draft.md')
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toBe('no-team-folder')
    })

    it('offers the scratch folder alongside the working directory to a refused publisher', () => {
      const msg = explainArtifactRefRejection('outside-work-dir', { ref: '/tmp/x.md', workDir, teamFolder: folder })
      expect(msg).toContain(`Your working directory is "${workDir}"`)
      expect(msg).toContain(`or write it in your scratch folder "${folder.self}"`)
    })

    it('words a rejection exactly as before when there is no scratch folder', () => {
      expect(explainArtifactRefRejection('outside-work-dir', { ref: 'x.md', workDir, teamFolder: null })).toBe(
        `"x.md" is outside your working directory, so teammates cannot open it — a path on your machine ` +
          `means nothing on theirs. Your working directory is "${workDir}". Either write the file there and ` +
          'publish it by its path relative to that directory (e.g. "docs/design.md"), or drop the reference ' +
          'and share the content itself.'
      )
    })
  })

  it('formats sizes for the publish receipt', () => {
    expect(formatArtifactSize(512)).toBe('512 B')
    expect(formatArtifactSize(2048)).toBe('2.0 KB')
    expect(formatArtifactSize(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})
