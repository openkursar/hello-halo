/**
 * Where a change landed, grouped by path: the overview's key numbers and its
 * directory heat map. Computed from the change list alone — no AI, no reads.
 */

import type { ViewFile } from '../model/view-files'
import { isNewFile } from '../model/view-files'
import { dirName } from '../model/paths'

/** Top-level folders that only hold other areas; one more segment names the area. */
const CONTAINER_DIRS = new Set(['src', 'packages', 'apps', 'libs', 'lib', 'modules', 'services', 'crates', 'cmd', 'internal', 'pkg', 'app'])

export interface DirectoryStats {
  /** Repository-relative directory; '' is the repository root. */
  dir: string
  files: number
  /** Files with line counts (not binary). */
  textFiles: number
  additions: number
  deletions: number
  newFiles: number
}

export interface AreaStats {
  /** Leading path the area's directories share; '' is the repository root. */
  area: string
  additions: number
  deletions: number
  /** Largest change first. */
  dirs: DirectoryStats[]
}

export interface ChangeDistribution {
  files: number
  dirs: number
  additions: number
  deletions: number
  newFiles: number
  /** Largest change first. */
  areas: AreaStats[]
  /** Biggest directory change, the full length of a bar. */
  maxDirLines: number
  /** Every directory in the order the overview lists them; `[` `]` walk this. */
  order: string[]
}

/** The area a directory belongs to: its first segment, or two for container folders like `src`. */
export function areaOf(dir: string): string {
  if (dir === '') return ''
  const segments = dir.split('/')
  if (segments.length >= 2 && CONTAINER_DIRS.has(segments[0])) return `${segments[0]}/${segments[1]}`
  return segments[0]
}

const linesOf = (s: { additions: number; deletions: number }) => s.additions + s.deletions

function bySizeThenName<T extends { additions: number; deletions: number }>(name: (item: T) => string) {
  return (a: T, b: T) => linesOf(b) - linesOf(a) || (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0)
}

export function computeDistribution(files: readonly ViewFile[]): ChangeDistribution {
  const dirs = new Map<string, DirectoryStats>()
  let additions = 0
  let deletions = 0
  let newFiles = 0
  for (const file of files) {
    const dir = dirName(file.path)
    let stats = dirs.get(dir)
    if (!stats) {
      stats = { dir, files: 0, textFiles: 0, additions: 0, deletions: 0, newFiles: 0 }
      dirs.set(dir, stats)
    }
    const fresh = isNewFile(file.state) ? 1 : 0
    stats.files++
    if (file.additions !== null || file.deletions !== null) stats.textFiles++
    stats.additions += file.additions ?? 0
    stats.deletions += file.deletions ?? 0
    stats.newFiles += fresh
    additions += file.additions ?? 0
    deletions += file.deletions ?? 0
    newFiles += fresh
  }

  const areas = new Map<string, AreaStats>()
  let maxDirLines = 0
  for (const stats of dirs.values()) {
    const key = areaOf(stats.dir)
    let area = areas.get(key)
    if (!area) {
      area = { area: key, additions: 0, deletions: 0, dirs: [] }
      areas.set(key, area)
    }
    area.dirs.push(stats)
    area.additions += stats.additions
    area.deletions += stats.deletions
    maxDirLines = Math.max(maxDirLines, linesOf(stats))
  }

  const sortedAreas = [...areas.values()].sort(bySizeThenName((a) => a.area))
  for (const area of sortedAreas) area.dirs.sort(bySizeThenName((d) => d.dir))

  return {
    files: files.length,
    dirs: dirs.size,
    additions,
    deletions,
    newFiles,
    areas: sortedAreas,
    maxDirLines,
    order: sortedAreas.flatMap((area) => area.dirs.map((d) => d.dir)),
  }
}

/** An area gets a heading only when it groups more than one directory. */
export function areaHasHeading(area: AreaStats): boolean {
  return area.dirs.length > 1
}

/**
 * How a directory reads in the list: under its area's heading, the rest of the
 * path; the area's own folder, and a folder alone in its area, in full. The
 * repository root ('') is for the caller to name.
 */
export function dirLabel(dir: string, area: AreaStats): string {
  if (!areaHasHeading(area) || dir === area.area) return dir
  return dir.startsWith(`${area.area}/`) ? dir.slice(area.area.length + 1) : dir
}
