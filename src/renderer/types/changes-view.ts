/**
 * What a changes tab remembers while its viewer is unmounted (the tab is
 * hidden): sub-page, repository, compare scope, panel filter, folded cards and
 * scroll positions. Kept on `tab.view.changes` (see `TabViewState` in
 * services/canvas-lifecycle), which every snapshot of the tab shares; the
 * changes viewer (components/canvas/viewers/changes) writes it as the user
 * moves around and reads it back on mount.
 */

export type ChangesPage = 'changes' | 'overview'

/**
 * A compare scope as a tab stores it. "Since last review" keeps no snapshot:
 * it always means the repository's latest review, whose snapshot is read when
 * the list loads.
 */
export type StoredCompareScope =
  | { kind: 'uncommitted' }
  | { kind: 'staged' }
  | { kind: 'since-review' }
  | { kind: 'revision'; revision: string; mergeBase: boolean }

/** The directory or file detail opened from the overview, walked with `[` and `]`. */
export interface DetailState {
  kind: 'dir' | 'file'
  /** Repository-relative directories ('' for the root) or file paths, in walking order. */
  items: string[]
  index: number
  /** A line to bring into view when a file was entered from a report link. */
  line?: number
  /** Which of the report's file mentions was followed, to point back at it on return. */
  mention?: number
}

export interface ChangesViewMemory {
  page: ChangesPage
  /** Repository shown by a git tab; absent until one is chosen. */
  repoRoot?: string
  scope: StoredCompareScope
  filter: string
  /** Card keys the user folded. */
  folded: string[]
  /** Generated or very large files the user chose to show anyway. */
  loaded: string[]
  /**
   * Files shown although the filter or "hide generated" would leave them out,
   * because a reference or a report link pointed at them; cleared when the
   * user changes either.
   */
  forced: string[]
  /** Card at the top of the stack, and how far into it the view was scrolled. */
  stackAnchor?: { key: string; offset: number }
  overviewScroll: number
  detail: DetailState | null
  commitMessage: string
}
