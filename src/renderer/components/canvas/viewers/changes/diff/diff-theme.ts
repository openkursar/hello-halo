/** Theme-aware syntax and quiet change tints for read-only diffs. */

import { HighlightStyle } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'

const ADD = 'var(--diff-add)'
const DEL = 'var(--diff-del)'
const MONO = "'SF Mono', 'Fira Code', 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace"

export const diffHighlightStyle = HighlightStyle.define([
  { tag: [tags.name, tags.operator, tags.punctuation, tags.meta], color: 'hsl(var(--foreground))' },
  { tag: tags.comment, color: 'hsl(var(--foreground))', fontStyle: 'italic' },
  { tag: tags.keyword, color: 'hsl(var(--diff-syntax-keyword))' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'hsl(var(--diff-syntax-function))' },
  { tag: [tags.string, tags.character, tags.regexp], color: 'hsl(var(--diff-syntax-string))' },
  { tag: [tags.number, tags.bool, tags.null], color: 'hsl(var(--diff-syntax-number))' },
])

export const diffEditorTheme = EditorView.theme({
  '&': {
    fontSize: '12.5px',
    backgroundColor: 'hsl(var(--background))',
    color: 'hsl(var(--foreground))',
    // A reference's flash lies over the line tints below; softened, diff syntax stays readable on it.
    '--halo-reveal-alpha': '0.14',
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
    backgroundColor: 'hsl(var(--primary) / 0.18)',
  },

  // Replacing the whole background also removes the merge package's gradient underlines.
  '&.cm-merge-a .cm-changedLine, .cm-deletedChunk': { background: `hsl(${DEL} / 0.07) !important` },
  '&.cm-merge-a .cm-changedText, .cm-deletedText, &.cm-merge-b .cm-deletedText': {
    background: `hsl(${DEL} / 0.14) !important`,
    textDecoration: 'none !important',
  },
  '&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine': { background: `hsl(${ADD} / 0.07) !important` },
  '&.cm-merge-b .cm-changedText, .cm-inlineChangedLine .cm-changedText, .cm-insertedText': {
    background: `hsl(${ADD} / 0.14) !important`,
    textDecoration: 'none !important',
  },
  '&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter': { background: `hsl(${DEL}) !important` },
  '&.cm-merge-b .cm-changedLineGutter, .cm-inlineChangedLineGutter': { background: `hsl(${ADD}) !important` },
  '.cm-mergeSpacer': { background: 'hsl(var(--secondary) / 0.5)' },

  '.cm-deletedChunk': { paddingLeft: '6px' },
  '.cm-insertedLine, .cm-deletedLine, .cm-deletedLine del': { textDecoration: 'none' },
  '.cm-changeGutter': { width: '3px', paddingLeft: '0' },

  // A file that exists on one side only.
  '&.cm-wholeInserted .cm-line': { backgroundColor: `hsl(${ADD} / 0.07)` },
  '&.cm-wholeDeleted .cm-line': { backgroundColor: `hsl(${DEL} / 0.07)` },

  // Where a jump landed (report links, references) and the change F7 moved to,
  // for a moment; above the added/deleted tint.
  '& .cm-line.cm-changesFlash, &.cm-merge-a .cm-line.cm-changesFlash, &.cm-merge-b .cm-line.cm-changesFlash': {
    background: 'hsl(var(--halo-warning) / 0.14) !important',
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
