/**
 * Replacing the editor's document from outside (a disk refresh, a revert) is
 * not an undoable edit: undo never brings back stale text, and repeated
 * refreshes do not pile whole-document copies into history.
 */

import { describe, it, expect } from 'vitest'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import { history, undo, undoDepth } from '@codemirror/commands'
import type { EditorView } from '@codemirror/view'
import { setContent } from '../../../../src/renderer/lib/codemirror-setup'

function fakeView(doc: string) {
  const view = {
    state: EditorState.create({ doc, extensions: [history()] }),
    dispatch(spec: TransactionSpec) {
      view.state = view.state.update(spec).state
    },
  }
  return view
}

describe('setContent', () => {
  it('replaces the document without an undo entry', () => {
    const view = fakeView('file A')
    setContent(view as unknown as EditorView, 'file B')
    expect(view.state.doc.toString()).toBe('file B')
    expect(undoDepth(view.state)).toBe(0)
  })

  it('keeps history flat across many refreshes of a large file', () => {
    const view = fakeView('x'.repeat(1 << 20))
    for (let i = 0; i < 60; i++) {
      setContent(view as unknown as EditorView, String(i).repeat(1 << 20))
    }
    expect(undoDepth(view.state)).toBe(0)
  })

  it('never lets undo restore text that came from outside', () => {
    const view = fakeView('old disk text')
    view.dispatch({ changes: { from: 0, insert: '// my edit\n' } })
    setContent(view as unknown as EditorView, 'new disk text')

    undo({ state: view.state, dispatch: (tr) => { view.state = tr.state } })
    expect(view.state.doc.toString()).not.toContain('old disk text')
  })
})
