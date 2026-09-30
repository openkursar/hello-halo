/**
 * apps/manager -- Bundle seed stamp
 *
 * Remembers which bundle each idle-time seeder (built-in apps, built-in
 * skills) last applied in full, so a launch whose bundle is unchanged skips
 * the seeder instead of re-reading every bundled file and installed row.
 *
 * A seeder marks its bundle only after a run with no failures, so a partial
 * run (offline store, bad spec) is retried on the next launch. The cost of
 * skipping: a bundled row the user deleted by hand comes back only with the
 * next bundle change.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { getHaloDir } from '../../foundation/config.service'

type Seeder = 'builtin-apps' | 'builtin-skills'

function stampPath(): string {
  return join(getHaloDir(), 'bundle-seed.json')
}

function readStamps(): Partial<Record<Seeder, string>> {
  const path = stampPath()
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** The app version plus the seeder's own view of its bundle's contents. */
export function bundleKey(contentKey: string): string {
  return `${app.getVersion()}|${contentKey}`
}

export function isBundleSeeded(seeder: Seeder, key: string): boolean {
  return readStamps()[seeder] === key
}

export function markBundleSeeded(seeder: Seeder, key: string): void {
  try {
    writeFileSync(stampPath(), JSON.stringify({ ...readStamps(), [seeder]: key }), 'utf8')
  } catch (err) {
    console.warn(`[BundleSeed] Failed to record ${seeder} stamp; it will run again next launch:`, err)
  }
}
