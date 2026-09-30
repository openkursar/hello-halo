/**
 * The one rule mapping a published artifact `ref` to a file on disk. A ref names
 * a file in one of two places:
 *
 *  - the producer's TEAM FOLDER (see `team-folder.ts`), written
 *    `team:<member folder>/<path>` — where reviews, reports and notes belong;
 *  - the producer's WORKING directory — the directory its agent actually works
 *    in — written relative to its root, for what is itself a deliverable of the
 *    task (code, a document the user asked to have in the project).
 *
 * Both stored forms are portable: the same repository and the same team folder
 * sit at different absolute paths on every teammate's machine. But the model
 * reaches for absolute paths (its prompt shows them, its file writes use them),
 * so an absolute path inside either place is folded back to its portable form
 * rather than refused on a technicality — and anything else is refused with a
 * reason the agent can act on.
 *
 * Publishing and reading both resolve through here, so what a member may publish
 * and what a teammate may read can never drift apart. Symlinks are followed
 * before every containment test: a link inside a root that points outside it is
 * outside.
 */

import { existsSync, realpathSync, statSync } from 'fs'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import { TEAM_FOLDER_REF_PREFIX, isTeamFolderRef } from '../../../../shared/apps/team-types'
import type { TeamFolderPaths } from './team-folder'

/** Why a ref cannot name a file teammates can read. */
export type ArtifactRefRejection =
  | 'empty'
  | 'no-work-dir'
  | 'no-team-folder'
  | 'outside-work-dir'
  | 'other-member-folder'
  | 'missing'
  | 'not-a-file'

export type ArtifactRefResolution =
  | {
      ok: true
      /** Portable form to store and to hand to teammates: `team:`-prefixed or relative, POSIX-separated. */
      ref: string
      /** Absolute path on THIS machine. */
      absPath: string
      bytes: number
    }
  | { ok: false; reason: ArtifactRefRejection }

/** Where a publishing member may publish from. */
export interface PublishRoots {
  /** The member's working directory. */
  workDir: string
  /** The member's team folder; null when it has none (then only working-directory files publish). */
  teamFolder: TeamFolderPaths | null
  /**
   * Another member's sub-folder the ref may also come from: the assignee's,
   * when the caller attaches a file to that member's task. The ref then belongs
   * to its real producer, as a task's resultRef always does.
   */
  claimantFolder?: string | null
}

/** Where a published ref may be read from on this machine. */
export interface ReadRoots {
  /** The producer's working directory; null when unknown here. */
  workDir: string | null
  /** The folder of this piece of work (`TeamFolderPaths.shared`); null when unknown here. */
  teamFolder: string | null
}

/** Resolve symlinks when the path exists; a not-yet-existing path stays lexical. */
function realOrLexical(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : path
  } catch {
    return path
  }
}

/** Whether `abs` is the root itself or sits under it (both already real paths). */
function isWithin(root: string, abs: string): boolean {
  const rel = relative(root, abs)
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))
}

function toPosix(rel: string): string {
  return rel.split(sep).join('/')
}

function fileAt(abs: string, ref: string): ArtifactRefResolution {
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(abs)
  } catch {
    return { ok: false, reason: 'missing' }
  }
  if (!stat.isFile()) return { ok: false, reason: 'not-a-file' }
  return { ok: true, ref, absPath: abs, bytes: stat.size }
}

/**
 * A `team:` ref's path inside the team folder. Null when it escapes the folder or
 * does not reach below a member's sub-folder — a ref always names one member's file.
 */
function resolveInTeamFolder(sharedDir: string, ref: string): { abs: string; rel: string } | null {
  const root = realOrLexical(resolve(sharedDir))
  const tail = ref.slice(TEAM_FOLDER_REF_PREFIX.length)
  if (!tail.trim() || isAbsolute(tail)) return null
  const abs = realOrLexical(resolve(join(root, tail)))
  if (!isWithin(root, abs)) return null
  const rel = relative(root, abs)
  return rel.split(sep).length >= 2 ? { abs, rel } : null
}

/** Whether a team-folder file sits where this publish may take it from. */
function mayPublishFrom(roots: PublishRoots, abs: string): boolean {
  const own = roots.teamFolder ? [roots.teamFolder.self] : []
  const allowed = roots.claimantFolder ? [...own, roots.claimantFolder] : own
  return allowed.some((dir) => isWithin(realOrLexical(resolve(dir)), abs))
}

/**
 * Resolve a ref a member is about to publish. Accepts a `team:` ref, a path
 * relative to the working directory, or an absolute path inside either root.
 * A team-folder file publishes only from the sub-folder of the member that
 * will own the ref — the caller's, or a task assignee's — so the ref names its
 * real producer.
 */
export function resolveArtifactRef(roots: PublishRoots, ref: string): ArtifactRefResolution {
  const raw = ref.trim()
  if (!raw) return { ok: false, reason: 'empty' }
  const folder = roots.teamFolder

  if (isTeamFolderRef(raw)) {
    if (!folder) return { ok: false, reason: 'no-team-folder' }
    const found = resolveInTeamFolder(folder.shared, raw)
    if (!found) return { ok: false, reason: 'outside-work-dir' }
    if (!mayPublishFrom(roots, found.abs)) return { ok: false, reason: 'other-member-folder' }
    return fileAt(found.abs, TEAM_FOLDER_REF_PREFIX + toPosix(found.rel))
  }

  const workRoot = roots.workDir.trim() ? realOrLexical(resolve(roots.workDir)) : null
  if (!isAbsolute(raw) && !workRoot) return { ok: false, reason: 'no-work-dir' }
  const abs = realOrLexical(isAbsolute(raw) || !workRoot ? resolve(raw) : resolve(join(workRoot, raw)))

  // Team folder first: it is the narrower place, and a working directory as wide
  // as the home folder would otherwise claim it.
  if (folder) {
    const sharedRoot = realOrLexical(resolve(folder.shared))
    if (isWithin(sharedRoot, abs)) {
      if (!mayPublishFrom(roots, abs)) return { ok: false, reason: 'other-member-folder' }
      return fileAt(abs, TEAM_FOLDER_REF_PREFIX + toPosix(relative(sharedRoot, abs)))
    }
  }
  if (!workRoot) return { ok: false, reason: folder ? 'outside-work-dir' : 'no-work-dir' }
  const inWorkDir = isWithin(workRoot, abs) ? fileAt(abs, toPosix(relative(workRoot, abs))) : null
  if (inWorkDir?.ok) return inWorkDir
  // Models name a team-folder file by a bare path as often as by its ref —
  // relative to their own folder ("review.md") or to the shared one
  // ("reviewer/review.md"). The working directory wins when it has the file.
  if (folder && !isAbsolute(raw)) {
    const sharedRoot = realOrLexical(resolve(folder.shared))
    const selfRoot = realOrLexical(resolve(folder.self))
    for (const candidate of [join(selfRoot, raw), join(sharedRoot, raw)]) {
      const found = realOrLexical(resolve(candidate))
      if (!isWithin(selfRoot, found)) continue
      const res = fileAt(found, TEAM_FOLDER_REF_PREFIX + toPosix(relative(sharedRoot, found)))
      if (res.ok) return res
    }
  }
  return inWorkDir ?? { ok: false, reason: 'outside-work-dir' }
}

/**
 * Resolve a ref that is already published, on the machine holding the file. A
 * `team:` ref resolves inside the folder of the piece of work (any member's
 * sub-folder: the board already says whose it is); any other ref inside the
 * producer's working directory. An absolute ref inside the working directory
 * is still served, since boards written before refs were folded carry them.
 */
export function resolvePublishedRef(roots: ReadRoots, ref: string): ArtifactRefResolution {
  const raw = ref.trim()
  if (!raw) return { ok: false, reason: 'empty' }
  if (isTeamFolderRef(raw)) {
    if (!roots.teamFolder) return { ok: false, reason: 'no-team-folder' }
    const found = resolveInTeamFolder(roots.teamFolder, raw)
    if (!found) return { ok: false, reason: 'outside-work-dir' }
    return fileAt(found.abs, TEAM_FOLDER_REF_PREFIX + toPosix(found.rel))
  }
  if (!roots.workDir?.trim()) return { ok: false, reason: 'no-work-dir' }
  const root = realOrLexical(resolve(roots.workDir))
  const abs = realOrLexical(isAbsolute(raw) ? resolve(raw) : resolve(join(root, raw)))
  if (!isWithin(root, abs)) return { ok: false, reason: 'outside-work-dir' }
  return fileAt(abs, toPosix(relative(root, abs)))
}

/**
 * Publisher-facing guidance for a rejected ref: what is wrong and what to do
 * instead, phrased for the member that just tried to publish it. The reader side
 * speaks to a different audience (someone holding a teammate's ref) and writes
 * its own wording.
 */
export function explainArtifactRefRejection(
  reason: ArtifactRefRejection,
  params: { ref: string; workDir: string; teamFolder: TeamFolderPaths | null }
): string {
  const { ref, workDir, teamFolder } = params
  const tail =
    `Your working directory is "${workDir}". Either write the file there and publish it ` +
    'by its path relative to that directory (e.g. "docs/design.md"), ' +
    (teamFolder ? `or write it in your scratch folder "${teamFolder.self}", ` : '') +
    'or drop the reference and share the content itself.'
  switch (reason) {
    case 'empty':
      return `An empty reference cannot be published. ${tail}`
    case 'no-work-dir':
      return teamFolder
        ? `Your working directory could not be determined, so "${ref}" cannot be published from it. ${tail}`
        : 'Your working directory could not be determined, so a file reference cannot be published ' +
            'right now. Share the content itself instead.'
    case 'no-team-folder':
      return `"${ref}" names a scratch-folder file, but you have no scratch folder here. ${tail}`
    case 'outside-work-dir':
      return (
        `"${ref}" is outside your working directory${teamFolder ? ' and scratch folder' : ''}, so ` +
        `teammates cannot open it — a path on your machine means nothing on theirs. ${tail}`
      )
    case 'other-member-folder':
      return `"${ref}" is in a teammate\u2019s scratch folder; only its owner can publish it. ${tail}`
    case 'missing':
      return `"${ref}" does not exist, so there is nothing for teammates to read. ${tail}`
    case 'not-a-file':
      return `"${ref}" is a directory, not a file. Publish a single file instead. ${tail}`
  }
}

/** Human-readable size for a publish receipt, so the member sees what landed. */
export function formatArtifactSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
