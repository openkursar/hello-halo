/**
 * app-type-detect.ts
 *
 * The single answer to "what kind of app is this package?", shared by the
 * archive and the folder import paths so the two can never disagree.
 *
 * Rules, in order:
 *   1. `SKILL.md` at the package root → skill. The community skill format is
 *      the contract; Halo's own `spec.yaml` rides along as metadata and must
 *      never outvote it.
 *   2. `spec.yaml` / `spec.yml` at the package root → digital human. A digital
 *      human keeps its bundled skills under `skills/<id>/`, so their SKILL.md
 *      never sits at the root and cannot satisfy rule 1.
 *   3. Neither → null.
 *
 * The root is resolved through `package-paths`, the same module the parsers
 * use, so a package can never be classified against one root and parsed against
 * another. `SKILL.md` is matched regardless of case, as the skill parser is;
 * `spec.yaml` is matched exactly, as the digital-human parser is — that file is
 * only ever written by Halo's own packer, so there is no drift to absorb.
 */

import type { AppType } from '../../../shared/apps/spec-types'
import { isIgnoredPackagePath, wrapperPrefix, findPackageEntry } from './package-paths'
import { readArchiveEntries } from './package-archive'

/** The app types a package can be imported as. */
export type DetectedAppType = Extract<AppType, 'skill' | 'automation'>

/** Classify a package from the relative paths it contains. */
export function detectAppType(paths: readonly string[]): DetectedAppType | null {
  const root = rootLevelNames(paths)
  if (findPackageEntry(root, 'SKILL.md')) return 'skill'
  if (root.has('spec.yaml') || root.has('spec.yml')) return 'automation'
  return null
}

/**
 * Classify a `.zip` / `.dhpkg` archive. Only the entry names are read, never
 * their contents. An archive that is unreadable or too large to read yields
 * null — the caller is asking a question it can do without an answer to.
 */
export async function detectArchiveAppType(file: File): Promise<DetectedAppType | null> {
  try {
    return detectAppType(Object.keys(await readArchiveEntries(file)))
  } catch {
    return null
  }
}

/** File names sitting at the package root, once the wrapper folder is stripped. */
function rootLevelNames(paths: readonly string[]): Set<string> {
  const usable = paths.filter(path => !isIgnoredPackagePath(path))
  const prefix = wrapperPrefix(usable)

  const names = new Set<string>()
  for (const path of usable) {
    const relative = path.slice(prefix.length)
    if (relative && !relative.includes('/')) names.add(relative)
  }
  return names
}
