/**
 * Versions that swapped in on this machine and could not start.
 *
 * The helper records one here when it backs a swap out. Without that memory
 * the next check finds the same release, stages it, swaps it, waits, rolls
 * back, and starts over — a loop the user cannot leave, because every attempt
 * ends exactly where it began.
 *
 * Local to this install by design: a release that cannot start here may be
 * perfectly fine elsewhere, so the judgement travels no further than the
 * machine that made it.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const FAILED_VERSIONS_FILE = 'failed-versions.txt'

/** Versions recorded as unable to start, oldest first. */
export function readFailedVersions(workDir: string): string[] {
  const path = join(workDir, FAILED_VERSIONS_FILE)
  if (!existsSync(path)) return []
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  } catch (error) {
    // An unreadable record must not block updating entirely; the worst case is
    // one more attempt at a version that already failed.
    console.error('[Updater] Could not read the failed-version record:', error)
    return []
  }
}

export function hasFailedBefore(workDir: string, version: string): boolean {
  return readFailedVersions(workDir).includes(version)
}
