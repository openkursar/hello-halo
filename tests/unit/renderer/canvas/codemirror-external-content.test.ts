/**
 * Replacing the editor's document from outside (a disk refresh, a revert) is
 * not an undoable edit: undo never brings back stale text, and repeated
 * refreshes do not pile whole-document copies into history.
 */

import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EditorState, type Transaction, type TransactionSpec } from '@codemirror/state'
import { history, undo, undoDepth } from '@codemirror/commands'
import { EditorView, type ViewUpdate } from '@codemirror/view'
import { externalContentChange, setContent } from '../../../../src/renderer/lib/codemirror-setup'
import { CodeMirrorEditor } from '../../../../src/renderer/components/canvas/viewers/CodeMirrorEditor'

function fakeView(doc: string) {
  const view = {
    state: EditorState.create({ doc, extensions: [history()] }),
    transactions: [] as Transaction[],
    dispatch(spec: TransactionSpec) {
      const transaction = view.state.update(spec)
      view.transactions.push(transaction)
      view.state = transaction.state
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

  it('identifies disk replacements without classifying later edits or undo as outside content', () => {
    const view = fakeView('old disk text')
    setContent(view as unknown as EditorView, 'new disk text')
    expect(view.transactions.at(-1)!.annotation(externalContentChange)).toBe(true)

    view.dispatch({ changes: { from: 0, insert: 'my edit ' } })
    expect(view.transactions.at(-1)!.annotation(externalContentChange)).toBeUndefined()
    let undone: Transaction | undefined
    expect(undo({ state: view.state, dispatch: transaction => { undone = transaction; view.state = transaction.state } })).toBe(true)
    expect(undone!.annotation(externalContentChange)).toBeUndefined()
    expect(view.state.doc.toString()).toBe('new disk text')
  })

  it('does not echo disk synchronization through onChange, but reports typing and undo', () => {
    const onChange = vi.fn()
    const registration = vi.spyOn(EditorView.updateListener, 'of')
    try {
      renderToStaticMarkup(createElement(CodeMirrorEditor, { content: 'old disk text', readOnly: false, onChange }))
      expect(registration).toHaveBeenCalledTimes(1)
      const listener = registration.mock.calls[0][0]
      const view = fakeView('old disk text')
      const notify = (transaction: Transaction) => {
        const update: ViewUpdate = {
          view: view as unknown as EditorView,
          state: transaction.state,
          startState: transaction.startState,
          changes: transaction.changes,
          transactions: [transaction],
          docChanged: transaction.docChanged,
          selectionSet: transaction.selection !== undefined,
          viewportChanged: false,
          viewportMoved: false,
          heightChanged: false,
          geometryChanged: transaction.docChanged,
          focusChanged: false,
        }
        listener(update)
      }

      setContent(view as unknown as EditorView, 'new disk text')
      notify(view.transactions.at(-1)!)
      expect(onChange).not.toHaveBeenCalled()

      view.dispatch({ changes: { from: view.state.doc.length, insert: ' edited' } })
      notify(view.transactions.at(-1)!)
      expect(onChange.mock.calls).toEqual([['new disk text edited']])

      expect(undo({ state: view.state, dispatch: transaction => { view.state = transaction.state; notify(transaction) } })).toBe(true)
      expect(onChange.mock.calls).toEqual([['new disk text edited'], ['new disk text']])
    } finally { registration.mockRestore() }
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
