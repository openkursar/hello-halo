/**
 * Look of the diff editors: Halo's editor colors, compact for a stack of
 * files, with added and deleted text on the diff tokens (`--diff-add`,
 * `--diff-del`) — 12% for lines, 30% for the changed characters.
 */

import { EditorView } from '@codemirror/view'

const ADD = 'var(--diff-add)'
const DEL = 'var(--diff-del)'
const MONO = "'SF Mono', 'Fira Code', 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace"

export const diffEditorTheme = EditorView.theme({
  '&': {
    fontSize: '12.5px',
    backgroundColor: 'hsl(var(--background))',
    color: 'hsl(var(--foreground))',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: MONO, lineHeight: '1.6' },
  '.cm-content': { padding: '4px 0', caretColor: 'hsl(var(--primary))' },
  '.cm-line': { padding: '0 10px 0 6px' },
  '.cm-gutters': {
    backgroundColor: 'hsl(var(--background))',
    borderRight: '1px solid hsl(var(--border) / 0.6)',
    color: 'hsl(var(--subtle-foreground))',
    fontFamily: MONO,
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 10px', minWidth: '36px' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'hsl(var(--primary))' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'hsl(var(--primary) / 0.28)',
  },

  // Side by side: the before editor marks deletions, the after editor additions.
  // `background` (not just its color): the package draws changed text as a
  // gradient underline, which would otherwise show through.
  '&.cm-merge-a .cm-changedLine': { background: `hsl(${DEL} / 0.12) !important` },
  '&.cm-merge-a .cm-changedText': { background: `hsl(${DEL} / 0.30) !important` },
  '&.cm-merge-b .cm-changedLine': { background: `hsl(${ADD} / 0.12) !important` },
  '&.cm-merge-b .cm-changedText': { background: `hsl(${ADD} / 0.30) !important` },
  '&.cm-merge-a .cm-changedLineGutter': { background: `hsl(${DEL}) !important` },
  '&.cm-merge-b .cm-changedLineGutter': { background: `hsl(${ADD}) !important` },
  '.cm-mergeSpacer': { background: 'hsl(var(--secondary) / 0.5)' },

  // Inline: deleted lines are widgets above the added ones.
  '.cm-deletedChunk': { background: `hsl(${DEL} / 0.12) !important`, paddingLeft: '6px' },
  '.cm-deletedChunk .cm-deletedText': { background: `hsl(${DEL} / 0.30) !important` },
  '.cm-deletedLineGutter': { background: `hsl(${DEL}) !important` },
  '.cm-inlineChangedLine': { background: `hsl(${ADD} / 0.12) !important` },
  '.cm-inlineChangedLineGutter': { background: `hsl(${ADD}) !important` },
  '.cm-insertedLine, .cm-deletedLine, .cm-deletedLine del': { textDecoration: 'none' },
  '.cm-changeGutter': { width: '3px', paddingLeft: '0' },

  // A file that exists on one side only.
  '&.cm-wholeInserted .cm-line': { backgroundColor: `hsl(${ADD} / 0.12)` },
  '&.cm-wholeDeleted .cm-line': { backgroundColor: `hsl(${DEL} / 0.12)` },

  // Where a jump landed (report links, references) and the change F7 moved to,
  // for a moment; above the added/deleted tint.
  '& .cm-line.cm-changesFlash, &.cm-merge-a .cm-line.cm-changesFlash, &.cm-merge-b .cm-line.cm-changesFlash': {
    background: 'hsl(var(--halo-warning) / 0.32) !important',
  },
  '& .cm-line.cm-changesFocus, &.cm-merge-a .cm-line.cm-changesFocus, &.cm-merge-b .cm-line.cm-changesFocus': {
    boxShadow: 'inset 3px 0 0 hsl(var(--primary))',
  },

  // Folded unchanged lines: a quiet, clickable bar. The package's own bar is a
  // light-or-dark gradient picked by CodeMirror's theme flag, which Halo's
  // variable-driven theme does not set, so the whole background is replaced.
  '.cm-collapsedLines': {
    padding: '3px 12px !important',
    fontFamily: 'inherit',
    fontSize: '12px',
    color: 'hsl(var(--muted-foreground)) !important',
    background: 'hsl(var(--secondary)) !important',
    cursor: 'pointer',
    borderTop: '1px solid hsl(var(--border) / 0.6)',
    borderBottom: '1px solid hsl(var(--border) / 0.6)',
  },
  '.cm-collapsedLines:hover': { color: 'hsl(var(--foreground)) !important', background: 'hsl(var(--surface-hover)) !important' },
  '.cm-collapsedLines:before, .cm-collapsedLines:after': { display: 'none' },
})
