/**
 * apps/runtime -- Report Output Containment
 *
 * `report_to_user` accepts a `data_path` pointing at a file the agent wrote.
 * A path outside the space produces an activity entry the user cannot open —
 * silently, since the reader falls back to the (usually absent) inline data.
 *
 * Rather than reject such a path — the work is already done, and failing the
 * report loses it — the file is copied into the space and the entry points at
 * the copy.
 *
 * This is deliberately NOT FileExportGate: that gate answers "may this file
 * leave the machine" and admits tmpdir(), which is exactly one of the places
 * the user cannot see.
 */

import { copyFile, mkdir, realpath, stat } from 'fs/promises'
import { basename, extname, isAbsolute, join, resolve } from 'path'
import { getSpaceDir } from '../../services/space.service'
import { getOutputDir, isInsideSpace } from '../../services/space-scope'

/** Upper bound on collision-avoiding renames before falling back to a timestamp. */
const MAX_NAME_ATTEMPTS = 100

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function allocateName(dir: string, name: string): Promise<string> {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 0; i < MAX_NAME_ATTEMPTS; i++) {
    const candidate = i === 0 ? name : `${stem}-${i}${ext}`
    const path = join(dir, candidate)
    if (!(await exists(path))) return path
  }
  return join(dir, `${stem}-${Date.now()}${ext}`)
}

/**
 * Resolve a reported `data_path` to a path the user can actually open.
 *
 * Returns the path unchanged when the space is unknown or the target is not a
 * regular file — a directory or a device node is not something to copy, and a
 * missing file is the agent's mistake to surface, not this function's to hide.
 */
export async function reclaimReportedFile(
  reportedPath: string,
  spaceId: string | undefined
): Promise<string> {
  const spaceDir = spaceId ? getSpaceDir(spaceId) : ''
  if (!spaceDir) return reportedPath

  const absolute = isAbsolute(reportedPath)
    ? reportedPath
    : resolve(spaceDir, reportedPath)

  let stats: Awaited<ReturnType<typeof stat>>
  try {
    stats = await stat(absolute)
  } catch {
    return reportedPath
  }
  if (!stats.isFile()) return reportedPath

  const fileReal = await realpath(absolute)
  if (isInsideSpace(fileReal, spaceId)) return fileReal

  const outputDir = getOutputDir(spaceId)
  try {
    await mkdir(outputDir, { recursive: true })
    const target = await allocateName(outputDir, basename(fileReal))
    await copyFile(fileReal, target)
    console.log(
      `[Runtime] Reported file copied into the space: "${fileReal}" -> "${target}"`
    )
    return target
  } catch (err) {
    console.error(
      `[Runtime] Failed to copy reported file "${fileReal}" into "${outputDir}":`,
      err
    )
    return reportedPath
  }
}
