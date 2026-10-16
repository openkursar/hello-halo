import type { ViewFile } from '../model/view-files'
import type { DiffPart, LoadedDiff } from './diff-content'
import { languageForPath } from './diff-editor'

export const MAX_STACK_FILES = 8
export const MAX_STACK_LINES = 800
export const MAX_STACK_PARTS = 12
export const MAX_STACK_CHARS = 256 * 1024

/**
 * A file other than prose with a line longer than this does not wrap at all:
 * wrapped, a line is drawn whole (up to 20,000 characters) whenever any of it
 * shows, which takes more than a frame; unwrapped, only the stretch in view is
 * drawn.
 */
export const MAX_WRAPPED_LINE_CHARS = 5_000
/**
 * Unwrapped, each line in view is drawn up to about 4,000 characters, so a
 * file with more lines than this over `LONG_LINE_CHARS` stays wrapped, where
 * only the few long lines that fit the height are drawn.
 */
export const MAX_UNWRAPPED_LONG_LINES = 10
export const LONG_LINE_CHARS = 1_000

/** Languages (`languageForPath`) of text written to be read. A path with none (README, LICENSE) is read as such too. */
const PROSE_LANGUAGES = new Set(['md', 'markdown', 'mdx', 'txt', 'text', 'rst', 'adoc', 'asciidoc', 'org', 'tex'])

/**
 * Whether the diff of the file at `path` wraps its lines, so it reads without
 * scrolling sideways. Prose always does, whatever lines it holds; any other
 * file does unless a few lines are too long to wrap (a bundle, one-line data),
 * and then scrolls sideways instead.
 */
export function wrapsLines(path: string, part: Pick<DiffPart, 'before' | 'after'>): boolean {
  const language = languageForPath(path)
  if (language === null || PROSE_LANGUAGES.has(language)) return true
  let overlong = false
  let long = 0
  for (const text of [part.before, part.after]) {
    for (let start = 0; start <= text.length;) {
      const newline = text.indexOf('\n', start)
      const end = newline < 0 ? text.length : newline
      if (end - start > LONG_LINE_CHARS && ++long > MAX_UNWRAPPED_LONG_LINES) return true
      if (end - start > MAX_WRAPPED_LINE_CHARS) overlong = true
      start = end + 1
    }
  }
  return !overlong
}

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
