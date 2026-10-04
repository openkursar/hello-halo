/**
 * Rules over `ContentReference` (shared/types/content-reference) that every
 * surface must apply identically: bounding a reference to REFERENCE_LIMITS,
 * checking one that crossed a process boundary, the location a card shows,
 * and reading the references a message carries.
 *
 * Lives in `shared/` because the renderer bounds a reference when it is
 * created, the main process checks it again on arrival, and both show and
 * title messages from it; a second copy of any of these rules drifts.
 * Wording is left to the caller: nothing here produces a user-facing label.
 */

import { attachedPathName, canAttachPath, splitAttachedPaths } from './attached-paths'
import {
  REFERENCE_LIMITS,
  type ContentReference,
  type ContentReferenceKind,
  type ContentReferenceSource,
  type ReferenceLineRange,
} from './types/content-reference'

/** Longest path a reference may name; anything longer is not a real path. */
const MAX_PATH_CHARS = 4_096
/** Display strings carried on a source (titles, compare labels). */
const MAX_LABEL_CHARS = 300
/** Identifiers carried on a reference or its source. */
const MAX_ID_CHARS = 200

// ============================================
// Bounding
// ============================================

/**
 * At most `max` UTF-16 units of `text`, never splitting a surrogate pair at
 * the cut. `keep: 'end'` keeps the tail instead of the head.
 */
export function truncateChars(text: string, max: number, keep: 'start' | 'end' = 'start'): string {
  if (text.length <= max) return text
  if (max <= 0) return ''
  if (keep === 'end') {
    let start = text.length - max
    const unit = text.charCodeAt(start)
    if (unit >= 0xdc00 && unit <= 0xdfff) start += 1
    return text.slice(start)
  }
  let end = max
  const unit = text.charCodeAt(end - 1)
  if (unit >= 0xd800 && unit <= 0xdbff) end -= 1
  return text.slice(0, end)
}

/** Characters of a quote kept for this kind of source; 0 when it carries none. */
export function quoteCharLimit(kind: ContentReferenceKind): number {
  switch (kind) {
    case 'file':
    case 'diff':
      return REFERENCE_LIMITS.readableQuoteChars
    case 'terminal':
    case 'message':
      return REFERENCE_LIMITS.standaloneQuoteChars
    case 'path':
      return 0
  }
}

/** Which end of an over-long quote is kept: the newest terminal output is at its end. */
export function quoteKeptEnd(kind: ContentReferenceKind): 'start' | 'end' {
  return kind === 'terminal' ? 'end' : 'start'
}

/** Whether a quote of this kind may have been cut to its limit. */
export function isQuoteAtLimit(kind: ContentReferenceKind, quote: string): boolean {
  const limit = quoteCharLimit(kind)
  // A cut that avoided splitting a surrogate pair is one unit short.
  return limit > 0 && quote.length >= limit - 1
}

function sourceHasLines(kind: ContentReferenceKind): boolean {
  return kind === 'file' || kind === 'diff'
}

function normalizeRange(range: ReferenceLineRange | undefined): ReferenceLineRange | undefined {
  if (!range) return undefined
  const start = Math.floor(Number(range.startLine))
  const rawEnd = Math.floor(Number(range.endLine))
  if (!Number.isFinite(start) || start < 1) return undefined
  const end = Number.isFinite(rawEnd) && rawEnd >= 1 ? rawEnd : start
  return { startLine: Math.min(start, end), endLine: Math.max(start, end) }
}

/**
 * The reference bounded by REFERENCE_LIMITS: quote and note cut to their
 * limits, the note trimmed, a line range only where the source has lines and
 * ordered, and empty fields dropped. Idempotent.
 */
export function normalizeReference(ref: ContentReference): ContentReference {
  const kind = ref.source.kind
  const limit = quoteCharLimit(kind)
  const quote = limit > 0 && ref.quote ? truncateChars(ref.quote, limit, quoteKeptEnd(kind)) : ''
  const trimmedNote = ref.note?.trim() ?? ''
  const note = trimmedNote ? truncateChars(trimmedNote, REFERENCE_LIMITS.noteChars) : ''
  const range = sourceHasLines(kind) ? normalizeRange(ref.range) : undefined
  return {
    id: ref.id,
    source: ref.source,
    ...(range ? { range } : {}),
    ...(quote ? { quote } : {}),
    ...(note ? { note } : {}),
  }
}

// ============================================
// Checking references that crossed a process boundary
// ============================================

export type ReferencesParseResult =
  | { ok: true; references: ContentReference[] }
  | { ok: false; error: string }

type Fields = Record<string, unknown>

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(fields: Fields, key: string, max: number): string | null {
  const value = fields[key]
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

function optionalLabel(fields: Fields, key: string): string | undefined | null {
  const value = fields[key]
  if (value === undefined || value === null) return undefined
  return typeof value === 'string' ? truncateChars(value, MAX_LABEL_CHARS) : null
}

function absolutePath(fields: Fields, key: string): string | null {
  const path = requiredString(fields, key, MAX_PATH_CHARS)
  return path && canAttachPath(path) ? path : null
}

function parseSource(value: unknown): ContentReferenceSource | string {
  if (!isFields(value)) return 'source must be an object'
  switch (value.kind) {
    case 'file': {
      const path = absolutePath(value, 'path')
      if (!path) return 'file source needs an absolute path'
      const precision = value.precision === 'passage' ? 'passage' : value.precision === 'lines' ? 'lines' : null
      if (!precision) return 'file source needs a precision of "lines" or "passage"'
      return { kind: 'file', path, precision }
    }
    case 'diff': {
      const path = absolutePath(value, 'path')
      if (!path) return 'diff source needs an absolute path'
      if (value.side !== 'before' && value.side !== 'after') return 'diff source needs a side of "before" or "after"'
      const compareLabel = optionalLabel(value, 'compareLabel')
      if (!compareLabel) return 'diff source needs a compareLabel'
      let repo: { root: string; beforeRevision?: string } | undefined
      if (value.repo !== undefined && value.repo !== null) {
        if (!isFields(value.repo)) return 'diff source repo must be an object'
        const root = absolutePath(value.repo, 'root')
        if (!root) return 'diff source repo needs an absolute root'
        const revision = value.repo.beforeRevision
        if (revision !== undefined && revision !== null
          && (typeof revision !== 'string' || !/^[0-9a-f]{4,64}$/i.test(revision))) {
          return 'diff source beforeRevision must be a git object id'
        }
        repo = { root, ...(typeof revision === 'string' ? { beforeRevision: revision } : {}) }
      }
      return { kind: 'diff', path, side: value.side, compareLabel, ...(repo ? { repo } : {}) }
    }
    case 'terminal': {
      const title = optionalLabel(value, 'title')
      if (title === null || title === undefined) return 'terminal source needs a title'
      const sessionId = value.sessionId
      if (sessionId !== undefined && sessionId !== null && requiredString(value, 'sessionId', MAX_ID_CHARS) === null) {
        return 'terminal source sessionId must be a string'
      }
      return { kind: 'terminal', title, ...(typeof sessionId === 'string' ? { sessionId } : {}) }
    }
    case 'message': {
      const conversationId = requiredString(value, 'conversationId', MAX_ID_CHARS)
      const messageId = requiredString(value, 'messageId', MAX_ID_CHARS)
      if (!conversationId || !messageId) return 'message source needs a conversationId and a messageId'
      const conversationTitle = optionalLabel(value, 'conversationTitle')
      if (conversationTitle === null) return 'message source conversationTitle must be a string'
      if (value.whole !== undefined && typeof value.whole !== 'boolean') return 'message source whole must be a boolean'
      return {
        kind: 'message',
        conversationId,
        messageId,
        ...(conversationTitle ? { conversationTitle } : {}),
        ...(value.whole === true ? { whole: true } : {}),
      }
    }
    case 'path': {
      const path = absolutePath(value, 'path')
      if (!path) return 'path source needs an absolute path'
      if (typeof value.isDirectory !== 'boolean') return 'path source needs isDirectory'
      return { kind: 'path', path, isDirectory: value.isDirectory }
    }
    default:
      return 'unknown source kind'
  }
}

function parseReference(value: unknown): ContentReference | string {
  if (!isFields(value)) return 'must be an object'
  const id = requiredString(value, 'id', MAX_ID_CHARS)
  if (!id) return 'needs an id'
  const source = parseSource(value.source)
  if (typeof source === 'string') return source
  if (value.quote !== undefined && value.quote !== null && typeof value.quote !== 'string') return 'quote must be a string'
  if (value.note !== undefined && value.note !== null && typeof value.note !== 'string') return 'note must be a string'
  let range: ReferenceLineRange | undefined
  if (value.range !== undefined && value.range !== null) {
    if (!isFields(value.range)) return 'range must be an object'
    const { startLine, endLine } = value.range
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return 'range needs integer lines'
    range = { startLine: startLine as number, endLine: endLine as number }
  }
  return normalizeReference({
    id,
    source,
    ...(range ? { range } : {}),
    ...(typeof value.quote === 'string' ? { quote: value.quote } : {}),
    ...(typeof value.note === 'string' ? { note: value.note } : {}),
  })
}

/**
 * References received from another process, checked and bounded. A malformed
 * entry fails the whole list rather than being dropped: the user numbers
 * references by position, and silently losing one would shift every number
 * after it. Over-long texts are cut, not refused.
 */
export function parseReferences(value: unknown): ReferencesParseResult {
  if (value === undefined || value === null) return { ok: true, references: [] }
  if (!Array.isArray(value)) return { ok: false, error: 'references must be an array' }
  if (value.length > REFERENCE_LIMITS.maxPerMessage) {
    return { ok: false, error: `at most ${REFERENCE_LIMITS.maxPerMessage} references per message` }
  }
  const references: ContentReference[] = []
  const ids = new Set<string>()
  for (let i = 0; i < value.length; i++) {
    const parsed = parseReference(value[i])
    if (typeof parsed === 'string') return { ok: false, error: `references[${i}] ${parsed}` }
    if (ids.has(parsed.id)) return { ok: false, error: `references[${i}] repeats id "${parsed.id}"` }
    ids.add(parsed.id)
    references.push(parsed)
  }
  return { ok: true, references }
}

// ============================================
// Location
// ============================================

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/**
 * `path` relative to `baseDir` with forward slashes, '.' for the directory
 * itself, or null when it lies outside (or there is no base). Windows paths
 * compare case-insensitively.
 */
export function pathRelativeTo(path: string, baseDir: string | undefined): string | null {
  if (!baseDir) return null
  const insensitive = isWindowsPath(path) || isWindowsPath(baseDir)
  const base = baseDir.replace(/\\/g, '/').replace(/\/+$/, '')
  const target = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const fold = (s: string) => (insensitive ? s.toLowerCase() : s)
  if (fold(target) === fold(base)) return '.'
  if (!fold(target).startsWith(fold(base) + '/')) return null
  return target.slice(base.length + 1)
}

/** A path as shown: relative to `baseDir` when inside it, else as given. */
export function displayPath(path: string, baseDir?: string): string {
  return pathRelativeTo(path, baseDir) ?? path
}

/** '45-48', '12', or '' without a range. */
export function formatLineRange(range: ReferenceLineRange | undefined): string {
  if (!range) return ''
  return range.startLine === range.endLine ? `${range.startLine}` : `${range.startLine}-${range.endLine}`
}

export interface ReferenceLocation {
  /**
   * File or folder name, terminal tab title, or conversation title; '' when
   * the source has none and the caller names it (e.g. "AI reply").
   */
  name: string
  /** '45-48', '12', or ''. */
  lines: string
  /** For a file-backed source: relative to `baseDir` when inside it, else absolute. */
  path?: string
}

export function referenceLocation(ref: ContentReference, baseDir?: string): ReferenceLocation {
  const { source } = ref
  switch (source.kind) {
    case 'file':
    case 'diff':
    case 'path':
      return {
        name: attachedPathName(source.path),
        lines: source.kind === 'path' ? '' : formatLineRange(ref.range),
        path: displayPath(source.path, baseDir),
      }
    case 'terminal':
      return { name: source.title, lines: '' }
    case 'message':
      return { name: source.conversationTitle ?? '', lines: '' }
  }
}

/** `name:lines`, or the name alone. */
export function referenceLocationText(ref: ContentReference, baseDir?: string): string {
  const { name, lines } = referenceLocation(ref, baseDir)
  return lines ? `${name}:${lines}` : name
}

// ============================================
// Messages
// ============================================

/**
 * A message's text and the references it carries. Messages written before
 * references existed kept their attached paths as an `<attached_paths>` block
 * at the end of the text; those come back as path references, so every
 * surface shows and titles them the same way. For showing a message only —
 * a legacy block is never turned into references the model receives.
 */
export function messageReferences(
  content: string,
  references?: readonly ContentReference[]
): { text: string; references: ContentReference[] } {
  const { text, paths } = splitAttachedPaths(content)
  const legacy = paths.map((p, i): ContentReference => ({
    id: `attached-path-${i + 1}`,
    source: { kind: 'path', path: p.path, isDirectory: p.isDirectory },
  }))
  return { text, references: [...(references ?? []), ...legacy] }
}

/**
 * What a message is about, in one line of source text: its own text, or for
 * a message of cards alone the first card that names something — by its note,
 * else its location. A message of attached files and folders alone is named
 * by all of them, as attachments always were. '' when there is nothing to name.
 */
export function messageSummaryText(content: string, references?: readonly ContentReference[]): string {
  const { text, references: all } = messageReferences(content, references)
  if (text.trim()) return text
  if (all.length === 0) return ''
  if (all.every(ref => ref.source.kind === 'path' && !ref.note)) {
    return all.map(ref => referenceLocation(ref).name).join(', ')
  }
  for (const ref of all) {
    const named = ref.note || referenceLocationText(ref)
    if (named) return named
  }
  return ''
}
