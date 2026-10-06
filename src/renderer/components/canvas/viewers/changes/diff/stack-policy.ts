import type { ViewFile } from '../model/view-files'
import type { LoadedDiff } from './diff-content'

export const MAX_STACK_FILES = 8
export const MAX_STACK_LINES = 800
export const MAX_STACK_PARTS = 12
export const MAX_STACK_CHARS = 256 * 1024

/** The file list already has these costs; choosing a presentation never reads file contents. */
export function showOneFile(files: readonly ViewFile[]): boolean {
  if (files.length > MAX_STACK_FILES) return true
  let lines = 0
  let parts = 0
  let chars = 0
  for (const file of files) {
    if (file.binary) continue
    if (file.additions === null || file.deletions === null) return true
    lines += file.additions + file.deletions
    parts += file.written !== undefined ? 1 : Math.max(1, file.edits?.length ?? 0)
    chars += file.written?.length ?? 0
    for (const edit of file.edits ?? []) chars += edit.before.length + edit.after.length
    if (lines > MAX_STACK_LINES || parts > MAX_STACK_PARTS || chars > MAX_STACK_CHARS) return true
  }
  return false
}

export function diffChars(diff: LoadedDiff): number {
  return diff.kind === 'text' ? diff.parts.reduce((sum, part) => sum + part.before.length + part.after.length, 0) : 0
}

export interface ReadAdmission {
  /** The file may create its editors. */
  admit: boolean
  /** Whether to show all files or one has to be decided again. */
  recheck: boolean
}

/**
 * Text already read, priced against `MAX_STACK_CHARS` before editors mount:
 * line counts cannot price unchanged context or long lines.
 */
export class ReadBudget {
  private scope: string | undefined
  private readonly sizes = new Map<string, number>()

  /**
   * Sizes belong to the comparison they were read under, so another scope
   * forgets them. A refresh of the same scope keeps them: deciding afresh would
   * show every file of a large diff again only to read them all.
   */
  setScope(scope: string): void {
    if (scope === this.scope) return
    this.scope = scope
    this.sizes.clear()
  }

  /** Whether the known text of `files` is over budget; files not listed never count. */
  exceeds(files: readonly ViewFile[]): boolean {
    let total = 0
    for (const file of files) total += this.sizes.get(file.key) ?? 0
    return total > MAX_STACK_CHARS
  }

  /** Records a read. Past the budget in the all-files view, only the file the one-file view will show goes on. */
  admit(key: string, chars: number, view: { files: readonly ViewFile[]; single: boolean; selectedKey: string | undefined }): ReadAdmission {
    const changed = (this.sizes.get(key) ?? 0) !== chars
    this.sizes.set(key, chars)
    if (view.single) return { admit: true, recheck: changed }
    if (!this.exceeds(view.files)) return { admit: true, recheck: false }
    return { admit: key === view.selectedKey, recheck: true }
  }
}
