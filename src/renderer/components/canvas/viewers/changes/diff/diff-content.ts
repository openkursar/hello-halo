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
