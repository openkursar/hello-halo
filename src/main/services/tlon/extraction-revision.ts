import { lstatSync, type Stats } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { IngestHashesV1 } from '../../../shared/types/tlon'

type IngestRecord = IngestHashesV1['files'][string]
export type TextStamp = NonNullable<NonNullable<IngestRecord['protection']>['textStamp']>

export const XLSX_EXTRACTION_REVISION = 1

export function extractionRevision(path: string): number | undefined {
  return /\.xlsx$/i.test(path) ? XLSX_EXTRACTION_REVISION : undefined
}

export function isExtractionCurrent(path: string, record: IngestRecord): boolean {
  const required = extractionRevision(path)
  return required === undefined || (record.extractorRevision ?? 0) >= required
}

export function stampOf(stat: Stats): TextStamp {
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, dev: stat.dev }
}

export function textStamp(path: string): TextStamp {
  return stampOf(lstatSync(path))
}

export function sameTextStamp(left: TextStamp, right: TextStamp): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.ino === right.ino && left.dev === right.dev
}

/** Generated text is read only inside its directory, without traversing links. */
export function ownedTextPath(textDir: string, textPath: string): string | null {
  if (isAbsolute(textPath)) return null
  const target = resolve(textDir, textPath)
  const rel = relative(textDir, target)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) return null
  try {
    const directory = lstatSync(textDir)
    if (!directory.isDirectory() || directory.isSymbolicLink()) return null
    let current = textDir
    const segments = rel.split(sep)
    for (const [index, segment] of segments.entries()) {
      current = join(current, segment)
      const stat = lstatSync(current)
      if (stat.isSymbolicLink() || (index === segments.length - 1 ? !stat.isFile() : !stat.isDirectory())) return null
    }
    return target
  } catch { return null }
}

/** Only background candidate scans check the protected file's cheap identity. */
export function unchangedProtection(path: string, sourceHash: string, record: IngestRecord, textDir: string): boolean {
  const protection = record.protection
  if (!protection || protection.revision !== extractionRevision(path) || protection.sourceHash !== sourceHash) return false
  if (protection.scope === 'path') return record.textPath === protection.textPath
  try {
    if (!protection.textStamp) return false
    if (protection.scope === 'directory') return sameTextStamp(protection.textStamp, textStamp(textDir))
    if (!protection.textPath || /[\\/]/.test(protection.textPath) || protection.textPath === '.' || protection.textPath === '..') return false
    const directory = lstatSync(textDir)
    if (!directory.isDirectory() || directory.isSymbolicLink()) return false
    return sameTextStamp(protection.textStamp, textStamp(join(textDir, protection.textPath)))
  } catch { return false }
}
