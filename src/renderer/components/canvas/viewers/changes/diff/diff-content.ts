/**
 * What a file card shows once its contents are in: one or more text diffs,
 * or why there is none (binary, too large, no content change).
 */

import type { GitFileContents } from '../../../../../../shared/types/git'
import type { DiffKind } from './diff-editor'
import type { ViewFile } from '../model/view-files'

export interface DiffPart {
  id: string
  before: string
  after: string
  kind: DiffKind
  /** False for fragments whose line numbers are not the file's. */
  lineNumbers: boolean
}

export type LoadedDiff =
  | { kind: 'text'; parts: DiffPart[] }
  | { kind: 'binary'; beforeBytes?: number; afterBytes?: number }
  | { kind: 'too-large'; beforeBytes?: number; afterBytes?: number }
  /** Both sides read the same: a mode change, or a rename with nothing else. */
  | { kind: 'unchanged' }

export function diffFromGit(contents: GitFileContents): LoadedDiff {
  const sizes = { beforeBytes: contents.beforeBytes, afterBytes: contents.afterBytes }
  if (contents.binary) return { kind: 'binary', ...sizes }
  if (contents.tooLarge) return { kind: 'too-large', ...sizes }
  // A side exists exactly when its size is reported; its text can still be empty.
  const kind: DiffKind = contents.beforeBytes === undefined ? 'added' : contents.afterBytes === undefined ? 'deleted' : 'modified'
  const before = contents.before ?? ''
  const after = contents.after ?? ''
  if (kind === 'modified' && before === after) return { kind: 'unchanged' }
  return { kind: 'text', parts: [{ id: contents.path, before, after, kind, lineNumbers: true }] }
}

export function diffFromMessage(file: ViewFile): LoadedDiff {
  if (file.written !== undefined) {
    return { kind: 'text', parts: [{ id: file.key, before: '', after: file.written, kind: 'added', lineNumbers: true }] }
  }
  const parts = (file.edits ?? []).map((edit) => ({
    id: edit.id,
    before: edit.before,
    after: edit.after,
    kind: (edit.before === '' ? 'added' : edit.after === '' ? 'deleted' : 'modified') as DiffKind,
    lineNumbers: false,
  }))
  return parts.length ? { kind: 'text', parts } : { kind: 'unchanged' }
}

/** Estimated height of a card body that has not been measured yet. */
export function estimateBodyHeight(file: ViewFile, collapseUnchanged: boolean): number {
  if (file.binary) return 44
  const lines = (file.additions ?? 0) + (file.deletions ?? 0)
  const shown = collapseUnchanged ? Math.min(lines + 8, 2_000) : Math.min(lines + 40, 4_000)
  return Math.max(64, shown * LINE_HEIGHT + 8)
}

/** 12.5px text at 1.6 line height, as the diff theme sets it. */
export const LINE_HEIGHT = 20
