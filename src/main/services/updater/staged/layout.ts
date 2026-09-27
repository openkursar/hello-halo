/**
 * Where a staged update keeps its working files.
 *
 * Everything lives inside the install directory rather than in userData for
 * one reason: applying the update is a sequence of renames, and a rename is
 * only instant when both sides are on the same volume. Staging to a different
 * drive would silently turn the fast path back into a multi-hundred-MB copy —
 * the exact cost this feature exists to remove.
 *
 * Every entry here begins with a dot, which is also what the helper uses to
 * decide an entry is scratch and must not be swapped into place.
 */

import { app } from 'electron'
import { statfsSync } from 'fs'
import { dirname, join } from 'path'

/** Scratch directory name; the leading dot marks it as not-part-of-the-app. */
const WORK_DIR_NAME = '.halo-update'

export interface StagedLayout {
  /** Directory the running executable lives in. Never renamed or moved. */
  installDir: string
  /** Path of the running executable, used to relaunch after a swap. */
  exePath: string
  workDir: string
  downloadDir: string
  stagedDir: string
  backupDir: string
  stateFile: string
  /**
   * Where the helper records what it did.
   *
   * Deliberately the app's own log directory rather than the install tree: it
   * is the folder Settings opens, so the one artifact that explains a failed
   * update is somewhere the user can actually reach. It also sits outside the
   * directory being swapped, so a swap that goes wrong cannot take its own
   * account of events with it.
   */
  helperLog: string
}

export function resolveLayout(): StagedLayout {
  const exePath = app.getPath('exe')
  const installDir = dirname(exePath)
  const workDir = join(installDir, WORK_DIR_NAME)

  return {
    installDir,
    exePath,
    workDir,
    downloadDir: join(workDir, 'download'),
    stagedDir: join(workDir, 'staged'),
    backupDir: join(workDir, 'backup'),
    stateFile: join(workDir, 'state.json'),
    helperLog: join(app.getPath('logs'), 'update-helper.log'),
  }
}

/**
 * File the newly-started version writes to prove it came up.
 *
 * Named per version so a confirmation left behind by an earlier update can
 * never be mistaken for this one's.
 */
export function confirmFileFor(layout: StagedLayout, version: string): string {
  return join(layout.workDir, `confirmed-${version.replace(/[^\w.-]/g, '_')}.ok`)
}

/** The helper binary as shipped inside the app package. */
export function bundledHelperPath(): string {
  return join(process.resourcesPath, 'update-helper', 'halo-update-helper.exe')
}

/** Prefix of the helper copies below, so leftovers can be found and removed. */
export const HELPER_RUN_PREFIX = 'halo-update-helper-'

/**
 * Where the helper is copied before it runs the swap.
 *
 * The swap moves the install directory's contents aside, including the helper
 * that shipped in it, so the copy doing the work must sit where the swap does
 * not reach. The dot-prefixed work directory is that place, and unlike %TEMP%
 * it is not a location antivirus and AppLocker policies routinely block
 * executables from.
 */
export function helperRunPath(layout: StagedLayout): string {
  return join(layout.workDir, `${HELPER_RUN_PREFIX}${process.pid}.exe`)
}

/**
 * Whether the volume holding the install directory can take the update.
 *
 * Staging writes a second full copy of the application before anything is
 * applied, so the requirement is roughly the archive plus the unpacked tree.
 * Checked before downloading rather than after, so a machine that cannot
 * finish never spends the bandwidth.
 */
export function hasRoomToStage(layout: StagedLayout, packageBytes: number, unpackedBytes: number): boolean {
  try {
    const stats = statfsSync(layout.installDir)
    const free = stats.bavail * stats.bsize
    // A margin on top: finishing the update must not leave the machine with a
    // full disk, which breaks the app in a different way.
    const margin = 500 * 1024 * 1024
    return free > packageBytes + unpackedBytes + margin
  } catch (error) {
    // An unreadable filesystem is not proof there is no room; let the download
    // proceed and fail on a real error instead of guessing.
    console.warn('[Updater] Could not read free space, continuing:', error)
    return true
  }
}
