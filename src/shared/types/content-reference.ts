/**
 * A place in some content that the user pointed at and handed to the AI:
 * lines of a file, one side of a diff, a passage of a chat message, terminal
 * output, or a local file or folder attached as is.
 *
 * References travel on the user message (`metadata.references`) in the order
 * the user added them, and that order is their number (1, 2, …) everywhere:
 * the composer cards, the transcript cards and the block the model reads. The
 * model receives each one expanded (location, the excerpt as it was when
 * pointed at, the user's note); the transcript keeps only this record.
 */

export interface ReferenceLineRange {
  /** 1-based, inclusive. */
  startLine: number
  /** 1-based, inclusive; equal to `startLine` for a single line. */
  endLine: number
}

/** Text of a file open in the canvas: code, plain text, or Markdown source or preview. */
export interface FileReferenceSource {
  kind: 'file'
  /** Absolute path. */
  path: string
  /**
   * `lines`: taken from an editor, so `range` is exact. `passage`: taken from
   * rendered text (Markdown preview), so the quote is what locates it and
   * `range`, when present, is approximate.
   */
  precision: 'lines' | 'passage'
}

/** One side of a diff in the canvas changes view. */
export interface DiffReferenceSource {
  kind: 'diff'
  /** Absolute path of the file on the referenced side. */
  path: string
  side: 'before' | 'after'
  /** What the diff compares, as the user saw it (e.g. "Uncommitted changes"). */
  compareLabel: string
  /**
   * Set for a repository diff. `beforeRevision` is the git object the before
   * side was read from (a commit or tree id; absent when that side is the
   * index or the repository has no commits), so the model can read it with git.
   */
  repo?: { root: string; beforeRevision?: string }
}

/** Output shown in a canvas terminal. */
export interface TerminalReferenceSource {
  kind: 'terminal'
  /** Tab title at the time, for display. */
  title: string
  sessionId?: string
}

/** A passage of a chat message, such as an AI reply or a review report. */
export interface MessageReferenceSource {
  kind: 'message'
  conversationId: string
  messageId: string
  /** Conversation title at the time, for display. */
  conversationTitle?: string
  /** The whole message rather than a selected passage. */
  whole?: boolean
}

/** A local file or folder attached as is, with no excerpt (desktop only). */
export interface PathReferenceSource {
  kind: 'path'
  /** Absolute path. */
  path: string
  isDirectory: boolean
}

export type ContentReferenceSource =
  | FileReferenceSource
  | DiffReferenceSource
  | TerminalReferenceSource
  | MessageReferenceSource
  | PathReferenceSource

export type ContentReferenceKind = ContentReferenceSource['kind']

export interface ContentReference {
  /** Unique within its message. */
  id: string
  source: ContentReferenceSource
  /** Lines in the source's own numbering, when it has lines. */
  range?: ReferenceLineRange
  /** The pointed-at text as it was at that moment, already bounded by REFERENCE_LIMITS. */
  quote?: string
  /** The user's instruction for this spot (a comment); absent for a plain reference. */
  note?: string
}

export const REFERENCE_LIMITS = {
  /** References one message may carry. */
  maxPerMessage: 50,
  /** Characters kept of a quote whose source the model can read again (files, diffs). */
  readableQuoteChars: 2_000,
  /** Characters kept of a quote that is the only copy (terminal output, chat passages). */
  standaloneQuoteChars: 20_000,
  /** Characters of one note. */
  noteChars: 4_000,
} as const
