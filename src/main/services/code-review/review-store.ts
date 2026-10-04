/**
 * The latest review of each repository of a space, kept in the space's data
 * folder so it survives a restart. One record per repository; a new review
 * replaces the previous one.
 *
 * File: `<space data>/code-review/latest.json` = `{ version: 1, reviews: { [repoRoot]: record } }`.
 * The repository root is only ever a key in that file, never part of a path.
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { GitReviewRecord } from '../../../shared/types/git'
import { getSpace } from '../space.service'

const FILE_VERSION = 1
/** Far more than any space's review pointers; anything larger is not this file. */
const MAX_FILE_BYTES = 1024 * 1024

interface ReviewFile {
  version: typeof FILE_VERSION
  reviews: Record<string, GitReviewRecord>
}

/** Damaged files already reported: the view reads on every refresh, the log says it once. */
const reportedDamaged = new Set<string>()

function reportDamaged(file: string, reason: string): void {
  if (reportedDamaged.has(file)) return
  if (reportedDamaged.size >= 100) reportedDamaged.clear()
  reportedDamaged.add(file)
  console.warn(`[CodeReview] Ignoring unreadable review records ${file}: ${reason}`)
}

/** Where a space keeps its review records (beside its conversations). */
function storeFile(spaceId: string): string | null {
  const space = getSpace(spaceId)
  if (!space) return null
  return join(space.isTemp ? space.path : join(space.path, '.halo'), 'code-review', 'latest.json')
}

/** The stored records; {} when there is no file yet, null when it cannot be trusted. */
function readReviews(file: string): Record<string, unknown> | null {
  let text: string
  try {
    if (statSync(file).size > MAX_FILE_BYTES) {
      reportDamaged(file, 'file is too large')
      return null
    }
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    reportDamaged(file, (error as Error).message)
    return null
  }
  try {
    const parsed = JSON.parse(text) as Partial<ReviewFile> | null
    if (parsed?.version === FILE_VERSION && parsed.reviews && typeof parsed.reviews === 'object' && !Array.isArray(parsed.reviews)) {
      return parsed.reviews as Record<string, unknown>
    }
    reportDamaged(file, 'unexpected format')
  } catch {
    reportDamaged(file, 'not valid JSON')
  }
  return null
}

function isReviewRecord(value: unknown, repoRoot: string): value is GitReviewRecord {
  const record = value as Partial<GitReviewRecord> | null
  return (
    !!record &&
    record.repoRoot === repoRoot &&
    typeof record.conversationId === 'string' &&
    (record.variant === 'quick' || record.variant === 'team') &&
    typeof record.scope === 'object' &&
    record.scope !== null &&
    typeof record.scopeLabel === 'string' &&
    typeof record.snapshot === 'string' &&
    typeof record.fileCount === 'number' &&
    typeof record.startedAt === 'number'
  )
}

/** The latest review of `repoRoot` in this space, or null when none was recorded. */
export function getLatestReview(spaceId: string, repoRoot: string): GitReviewRecord | null {
  const file = storeFile(spaceId)
  if (!file) return null
  const reviews = readReviews(file)
  if (!reviews || !Object.prototype.hasOwnProperty.call(reviews, repoRoot)) return null
  const record = reviews[repoRoot]
  return isReviewRecord(record, repoRoot) ? record : null
}

/** Record `record` as the latest review of its repository in this space. */
export function saveLatestReview(spaceId: string, record: GitReviewRecord): void {
  const file = storeFile(spaceId)
  if (!file) throw new Error(`Unknown space: ${spaceId}`)
  // A damaged file, or a damaged entry, only held a pointer to an earlier review; it is dropped.
  const previous = Object.entries(readReviews(file) ?? {}).filter(
    (entry): entry is [string, GitReviewRecord] => entry[0] !== record.repoRoot && isReviewRecord(entry[1], entry[0]),
  )
  const reviews: Record<string, GitReviewRecord> = Object.fromEntries([...previous, [record.repoRoot, record]])
  const content: ReviewFile = { version: FILE_VERSION, reviews }

  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(content, null, 2)}\n`)
  renameSync(temporary, file)
}
