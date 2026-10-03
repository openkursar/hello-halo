/**
 * Numbered log archives for electron-log.
 *
 * electron-log's default rotation keeps a single `<name>.old<ext>`, so the
 * retained history is two files. Incident forensics routinely needs the day
 * before the report, so rotation shifts `<name>.1<ext>` … `<name>.N<ext>`
 * (1 = newest) and drops the oldest.
 */

import { existsSync, renameSync, unlinkSync } from 'fs'
import { join, parse } from 'path'

export const MAIN_LOG_MAX_BYTES = 10 * 1024 * 1024
export const MAIN_LOG_ARCHIVES = 5

/**
 * The file object electron-log hands to `archiveLogFn`. `crop` exists at runtime
 * but is missing from the published typings.
 */
interface ArchivableLogFile {
  readonly path: string
  clear(): boolean
  crop?: (bytesAfter: number) => void
}

export function archivePath(logPath: string, index: number): string {
  const { dir, name, ext } = parse(logPath)
  return join(dir, `${name}.${index}${ext}`)
}

/** Build an `archiveLogFn` keeping `maxArchives` numbered archives. */
export function createNumberedArchiveFn(maxArchives: number): (file: ArchivableLogFile) => void {
  return (file) => {
    const current = file.path
    try {
      const oldest = archivePath(current, maxArchives)
      if (existsSync(oldest)) unlinkSync(oldest)
      for (let i = maxArchives - 1; i >= 1; i--) {
        const from = archivePath(current, i)
        if (existsSync(from)) renameSync(from, archivePath(current, i + 1))
      }
      renameSync(current, archivePath(current, 1))

      // The single archive written by the default rotation is superseded.
      const { dir, name, ext } = parse(current)
      const legacy = join(dir, `${name}.old${ext}`)
      if (existsSync(legacy)) unlinkSync(legacy)
    } catch {
      // Same fallback as electron-log: keep the tail rather than grow unbounded.
      // No log call here — this runs inside the file transport, so logging would
      // re-enter rotation. The crop itself leaves a "[log cropped]" line.
      if (file.crop) file.crop(256 * 1024)
      else file.clear()
    }
  }
}
