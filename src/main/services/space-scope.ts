/**
 * services -- Space Scope
 *
 * In server mode a file is reachable by the user only while it sits inside the
 * space directory: that is what the Artifact panel lists, and remote reads
 * outside it are refused. Agents get that directory as their cwd but are free
 * to pass absolute paths anywhere, so "did this land somewhere the user can
 * see" has to be asked explicitly.
 *
 * Lives in services/ rather than in apps/runtime/ so that code which may not
 * import from apps/ can ask the same question.
 */

import { realpathSync } from 'fs'
import { join, resolve, sep } from 'path'
import { getSpaceDir } from './space.service'

/** Subdirectory of the space where agent-produced files are collected. */
const OUTPUT_DIR_NAME = 'outputs'

/** Tools whose target path is a file the user is meant to end up with. */
const USER_FACING_WRITE_TOOLS = new Set(['Write', 'NotebookEdit'])

/**
 * Both absolute forms of the space directory. The recorded path and its
 * realpath differ under a symlinked root (on macOS every path below
 * `os.tmpdir()`), and an agent may legitimately report either one.
 */
function spaceRoots(spaceId: string | undefined): string[] {
  const spaceDir = spaceId ? getSpaceDir(spaceId) : ''
  if (!spaceDir) return []
  const abs = resolve(spaceDir)
  try {
    const real = realpathSync(abs)
    return real === abs ? [abs] : [abs, real]
  } catch {
    return [abs]
  }
}

/**
 * Absolute path of the space's output directory, or `''` when the space is
 * unknown. Never created here — only a caller that actually has a file to put
 * there should create it, so an idle space stays clean.
 */
export function getOutputDir(spaceId: string | undefined): string {
  const roots = spaceRoots(spaceId)
  const root = roots[roots.length - 1]
  return root ? join(root, OUTPUT_DIR_NAME) : ''
}

/**
 * Pure path comparison — the caller decides whether symlinks matter. Pass a
 * realpath when the file exists; a path that does not exist yet can only be
 * compared literally.
 *
 * An unknown space answers `false`: nothing is in scope when there is no scope.
 */
export function isInsideSpace(absolutePath: string, spaceId: string | undefined): boolean {
  return spaceRoots(spaceId).some(
    root => absolutePath === root || absolutePath.startsWith(root + sep)
  )
}

/**
 * Record a file the agent created outside the space, which the user will not
 * find afterwards. Diagnostic only: blocking the write would break the many
 * legitimate reasons an agent edits files elsewhere, and the run has no way to
 * ask the user at this point.
 */
export function logWriteOutsideSpace(
  toolName: string,
  toolInput: Record<string, unknown>,
  spaceId: string | undefined,
  logPrefix: string
): void {
  if (!USER_FACING_WRITE_TOOLS.has(toolName)) return

  const filePath = toolInput.file_path
  if (typeof filePath !== 'string' || filePath.length === 0) return

  const roots = spaceRoots(spaceId)
  if (roots.length === 0) return

  const target = resolve(roots[0], filePath)
  if (isInsideSpace(target, spaceId)) return

  console.warn(
    `${logPrefix} ${toolName} target is outside the space and will not be ` +
    `visible to the user: "${target}" (space: "${roots[0]}")`
  )
}
