/**
 * The changes one AI reply made with its edit tools, as view files: each Edit
 * is a before/after fragment of the file, each Write the whole text written.
 * The fragments are not the file around them, so their line numbers are not
 * the file's.
 */

import type { FileChanges } from '../../../../diff'
import type { ViewFile } from '../model/view-files'
import { relativeTo } from '../model/paths'

function shownPath(absPath: string, folder: string | null): string {
  const relative = folder ? relativeTo(folder, absPath) : null
  return relative || absPath
}

export function messageViewFiles(changes: FileChanges, folder: string | null): ViewFile[] {
  const files: ViewFile[] = []
  for (const edit of changes.edits) {
    const chunks = edit.editChunks ?? [{ id: edit.id, oldString: edit.oldString ?? '', newString: edit.newString ?? '', stats: edit.stats }]
    files.push({
      key: `edit:${edit.file}`,
      path: shownPath(edit.file, folder),
      absPath: edit.file,
      state: 'modified',
      additions: edit.stats.added,
      deletions: edit.stats.removed,
      binary: false,
      generated: false,
      edits: chunks.map((chunk) => ({ id: chunk.id, before: chunk.oldString, after: chunk.newString })),
    })
  }
  for (const write of changes.writes) {
    files.push({
      key: `write:${write.file}`,
      path: shownPath(write.file, folder),
      absPath: write.file,
      state: 'added',
      additions: write.stats.added,
      deletions: 0,
      binary: false,
      generated: false,
      written: write.content ?? '',
    })
  }
  return files
}
