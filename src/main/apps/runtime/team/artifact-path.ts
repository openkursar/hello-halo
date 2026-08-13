/**
 * The one rule mapping a published artifact `ref` to a file on disk: a ref names
 * a file inside the producing member's WORKING directory — the directory its
 * agent actually works in — written relative to that directory's root.
 *
 * Relative is the stored form because it is the only portable one: the same
 * repository sits at a different absolute path on every teammate's machine. But
 * the model reaches for absolute paths (its prompt shows one, its file writes
 * use them, it quotes them in messages), so an absolute path INSIDE the work dir
 * is folded back to its relative form rather than refused on a technicality —
 * and anything outside is refused with a reason the agent can act on.
 *
 * Publishing and reading both resolve through here, so what a member may publish
 * and what a teammate may read can never drift apart. Symlinks are followed
 * before the containment test: a link inside the work dir that points outside it
 * is outside.
 */

import { existsSync, realpathSync, statSync } from 'fs'
import { isAbsolute, join, relative, resolve, sep } from 'path'

/** Why a ref cannot name a file teammates can read. */
export type ArtifactRefRejection = 'empty' | 'no-work-dir' | 'outside-work-dir' | 'missing' | 'not-a-file'

export type ArtifactRefResolution =
  | {
      ok: true
      /** Portable form to store and to hand to teammates: relative, POSIX-separated. */
      ref: string
      /** Absolute path on THIS machine. */
      absPath: string
      bytes: number
    }
  | { ok: false; reason: ArtifactRefRejection }

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

/**
 * Resolve a ref against a member's working directory, accepting either a
 * relative ref or an absolute path that lands inside that directory.
 */
export function resolveArtifactRef(workDir: string, ref: string): ArtifactRefResolution {
  const raw = ref.trim()
  if (!raw) return { ok: false, reason: 'empty' }
  if (!workDir.trim()) return { ok: false, reason: 'no-work-dir' }

  const root = realOrLexical(resolve(workDir))
  const abs = realOrLexical(isAbsolute(raw) ? resolve(raw) : resolve(join(root, raw)))
  if (!isWithin(root, abs)) return { ok: false, reason: 'outside-work-dir' }

  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(abs)
  } catch {
    return { ok: false, reason: 'missing' }
  }
  if (!stat.isFile()) return { ok: false, reason: 'not-a-file' }

  return { ok: true, ref: relative(root, abs).split(sep).join('/'), absPath: abs, bytes: stat.size }
}

/**
 * Publisher-facing guidance for a rejected ref: what is wrong and what to do
 * instead, phrased for the member that just tried to publish it. The reader side
 * speaks to a different audience (someone holding a teammate's ref) and writes
 * its own wording.
 */
export function explainArtifactRefRejection(
  reason: ArtifactRefRejection,
  params: { ref: string; workDir: string }
): string {
  const tail =
    `Your working directory is "${params.workDir}". Either write the file there and publish it ` +
    'by its path relative to that directory (e.g. "docs/design.md"), or drop the reference and ' +
    'share the content itself.'
  switch (reason) {
    case 'empty':
      return `An empty reference cannot be published. ${tail}`
    case 'no-work-dir':
      return (
        'Your working directory could not be determined, so a file reference cannot be published ' +
        'right now. Share the content itself instead.'
      )
    case 'outside-work-dir':
      return (
        `"${params.ref}" is outside your working directory, so teammates cannot open it — a path ` +
        `on your machine means nothing on theirs. ${tail}`
      )
    case 'missing':
      return `"${params.ref}" does not exist, so there is nothing for teammates to read. ${tail}`
    case 'not-a-file':
      return `"${params.ref}" is a directory, not a file. Publish a single file instead. ${tail}`
  }
}

/** Human-readable size for a publish receipt, so the member sees what landed. */
export function formatArtifactSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
