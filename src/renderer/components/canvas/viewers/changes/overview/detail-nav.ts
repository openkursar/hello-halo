/**
 * The detail page opened from the overview: one directory (from the change
 * distribution) or one file (from a report link) at a time, walked with
 * `[` and `]`, left with Esc back to where the overview was.
 */

import type { DetailState } from '../../../../../types/changes-view'
import type { ViewFile } from '../model/view-files'
import { dirName } from '../model/paths'

export function openDetail(
  kind: DetailState['kind'],
  items: string[],
  item: string,
  line?: number,
  mention?: number
): DetailState {
  const index = Math.max(0, items.indexOf(item))
  return { kind, items, index, ...(line !== undefined ? { line } : {}), ...(mention !== undefined ? { mention } : {}) }
}

/**
 * The state showing item `index`. The line to show belongs to the item the
 * page was entered at; the mention it was entered from is kept, to point back
 * at on return.
 */
export function detailAt(state: DetailState, index: number): DetailState {
  if (index === state.index) return state
  return { kind: state.kind, items: state.items, index, ...(state.mention !== undefined ? { mention: state.mention } : {}) }
}

/** The state after moving `delta` items, or the same state at either end. */
export function stepDetail(state: DetailState, delta: number): DetailState {
  return detailAt(state, Math.max(0, Math.min(state.items.length - 1, state.index + delta)))
}

export function currentItem(state: DetailState): string | undefined {
  return state.items[state.index]
}

/** Files the detail page shows for its current item. */
export function detailFiles(state: DetailState, files: readonly ViewFile[]): ViewFile[] {
  const item = currentItem(state)
  if (item === undefined) return []
  return state.kind === 'dir'
    ? files.filter((file) => dirName(file.path) === item)
    : files.filter((file) => file.path === item)
}

/** Index of the item that holds `path`, or -1 when the detail page has none. */
export function itemIndexOf(state: DetailState, path: string): number {
  return state.items.indexOf(state.kind === 'dir' ? dirName(path) : path)
}

const PATH_TOKEN = /[A-Za-z0-9_@.\-/]+/g

/**
 * Changed files a report mentions, in the order it first mentions them —
 * the files a report link's detail page walks through. The report names
 * files from its conversation's working directory; `prefix` is where the
 * repository sits in that directory ('' when it is the repository), and a
 * mention outside it is not one of this repository's files.
 */
export function filesMentionedIn(markdown: string, paths: readonly string[], prefix = ''): string[] {
  const known = new Set(paths)
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const match of markdown.matchAll(PATH_TOKEN)) {
    let token = match[0]
    if (token.startsWith('./')) token = token.slice(2)
    while (token.endsWith('.')) token = token.slice(0, -1)
    if (prefix) {
      if (!token.startsWith(`${prefix}/`)) continue
      token = token.slice(prefix.length + 1)
    }
    if (known.has(token) && !seen.has(token)) {
      seen.add(token)
      ordered.push(token)
    }
  }
  return ordered
}
