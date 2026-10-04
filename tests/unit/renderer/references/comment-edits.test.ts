/**
 * Comments written in the content: a new one becomes a comment when saved (a
 * plain selection when saved empty), an edit keeps what was typed until it is
 * saved, and sending the message takes whatever is still open — an edited
 * comment as edited, a new one with text as a comment, an empty new one not
 * at all.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../src/renderer/i18n', () => ({
  default: { t: (key: string, options?: Record<string, unknown>) => key.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? '')) },
}))

import {
  commitCommentEdits,
  endNewComment,
  hasNewCommentText,
  saveNewComment,
  setEditText,
  startEditing,
  startNewComment,
  stopEditing,
  useCommentEdits,
} from '../../../../src/renderer/components/references/comment-edits'
import { useComposerReferencesStore, type ReferenceDraft } from '../../../../src/renderer/stores/composer-references.store'

const store = () => useComposerReferencesStore.getState()
const list = (key: string) => store().drafts.get(key) ?? []
const texts = () => useCommentEdits.getState().texts

const lines = (line: number): ReferenceDraft => ({
  source: { kind: 'diff', path: '/repo/a.ts', side: 'after', compareLabel: 'Uncommitted changes' },
  range: { startLine: line, endLine: line },
  quote: `line ${line}`,
})

beforeEach(() => {
  useComposerReferencesStore.setState({ drafts: new Map(), target: { key: 'c1', title: 'T', visible: true, reveal: vi.fn() }, signal: null })
  useCommentEdits.setState({ texts: new Map(), newComments: new Map() })
})

describe('editing', () => {
  it('keeps what was typed when the comment is opened again, until it is closed', () => {
    startEditing('ref-1', 'first')
    setEditText('ref-1', 'typed')
    startEditing('ref-1', 'first')
    expect(texts().get('ref-1')).toBe('typed')
    stopEditing('ref-1')
    expect(texts().has('ref-1')).toBe(false)
    setEditText('ref-1', 'ignored once closed')
    expect(texts().has('ref-1')).toBe(false)
  })
})

describe('a new comment', () => {
  it('opens empty, and saved with text becomes a comment in the composer beside the content', () => {
    const id = startNewComment('c1', lines(4))
    expect(texts().get(id)).toBe('')
    setEditText(id, 'Why is this async?')
    saveNewComment(id, 'Why is this async?')
    expect(list('c1')).toHaveLength(1)
    expect(list('c1')[0]).toMatchObject({ note: 'Why is this async?', range: { startLine: 4, endLine: 4 } })
    expect(useCommentEdits.getState().newComments.has(id)).toBe(false)
    expect(texts().has(id)).toBe(false)
  })

  it('saved empty goes in as a plain selection, and discarded adds nothing', () => {
    saveNewComment(startNewComment('c1', lines(4)), '')
    expect(list('c1')).toHaveLength(1)
    expect(list('c1')[0].note).toBeUndefined()
    endNewComment(startNewComment('c1', lines(5)))
    expect(list('c1')).toHaveLength(1)
  })
})

describe('sending takes what is still open', () => {
  it('saves edited comments as edited, adds new ones with text, drops empty new ones', () => {
    store().add('c1', [{ ...lines(1), note: 'old' }, { ...lines(2), note: 'keep' }])
    const [edited, untouched] = list('c1')
    startEditing(edited.id, 'old')
    setEditText(edited.id, '  new text  ')
    const written = startNewComment('c1', lines(7))
    setEditText(written, 'And this one')
    const empty = startNewComment('c1', lines(8))

    commitCommentEdits('c1')

    expect(list('c1').map(ref => ref.note)).toEqual(['new text', 'keep', 'And this one'])
    expect(list('c1')[1].id).toBe(untouched.id)
    expect(texts().size).toBe(0)
    expect([...useCommentEdits.getState().newComments.keys()]).not.toContain(written)
    expect([...useCommentEdits.getState().newComments.keys()]).not.toContain(empty)
  })

  it('an edit cleared to nothing leaves a plain selection', () => {
    store().add('c1', [{ ...lines(1), note: 'old' }])
    const [ref] = list('c1')
    startEditing(ref.id, 'old')
    setEditText(ref.id, '   ')
    commitCommentEdits('c1')
    expect(list('c1')[0].note).toBeUndefined()
  })

  it("leaves another composer's comments open", () => {
    const elsewhere = startNewComment('c2', lines(3))
    setEditText(elsewhere, 'for another conversation')
    commitCommentEdits('c1')
    expect(list('c1')).toHaveLength(0)
    expect(useCommentEdits.getState().newComments.has(elsewhere)).toBe(true)
    expect(texts().get(elsewhere)).toBe('for another conversation')
  })

  it('counts a new comment as something to send only once it has text, and only for its composer', () => {
    const pending = (key: string) => hasNewCommentText(useCommentEdits.getState(), key)
    const id = startNewComment('c1', lines(4))
    expect(pending('c1')).toBe(false)
    setEditText(id, '  ')
    expect(pending('c1')).toBe(false)
    setEditText(id, 'Typed')
    expect(pending('c1')).toBe(true)
    expect(pending('c2')).toBe(false)
    endNewComment(id)
    expect(pending('c1')).toBe(false)
  })
})
