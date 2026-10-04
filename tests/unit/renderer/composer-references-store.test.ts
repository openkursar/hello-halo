/**
 * The composer's pending references: the order is the order the AI reads them
 * in and the lists show them in, so every operation must keep the list's
 * order and bounds exact.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { useComposerReferencesStore, getTargetReferences, type ReferenceDraft } from '../../../src/renderer/stores/composer-references.store'
import { REFERENCE_LIMITS } from '../../../src/shared/types/content-reference'

const store = () => useComposerReferencesStore.getState()
const list = (key: string) => store().drafts.get(key) ?? []

const fileDraft = (line: number, quote = `line ${line}`): ReferenceDraft => ({
  source: { kind: 'file', path: '/repo/src/a.ts', precision: 'lines' },
  range: { startLine: line, endLine: line },
  quote,
})
const pathDraft = (path: string): ReferenceDraft => ({ source: { kind: 'path', path, isDirectory: false } })

beforeEach(() => {
  useComposerReferencesStore.setState({ drafts: new Map(), target: null, signal: null })
})

describe('removing a group', () => {
  it('removes the given cards at once, and undo puts each back in its place', () => {
    store().add('c1', [fileDraft(1), fileDraft(2), fileDraft(3), fileDraft(4)])
    const [one, two, three, four] = list('c1')
    const undo = store().removeMany('c1', [two.id, four.id])
    expect(list('c1').map(ref => ref.id)).toEqual([one.id, three.id])
    undo()
    expect(list('c1').map(ref => ref.id)).toEqual([one.id, two.id, three.id, four.id])
  })

  it('undo keeps what changed since: new cards after the restored ones, edited notes as edited, cards removed since stay gone', () => {
    store().add('c1', [fileDraft(1), fileDraft(2), fileDraft(3)])
    const [one, two, three] = list('c1')
    const undo = store().removeMany('c1', [two.id])
    store().add('c1', [fileDraft(9)])
    store().updateNote('c1', one.id, 'edited later')
    store().remove('c1', three.id)
    undo()
    expect(list('c1').map(ref => ref.range?.startLine)).toEqual([1, 2, 9])
    expect(list('c1')[0].note).toBe('edited later')
  })

  it('does nothing for ids that are not there', () => {
    store().add('c1', [fileDraft(1)])
    const before = list('c1')
    store().removeMany('c1', ['missing'])()
    expect(list('c1')).toBe(before)
  })
})

describe('adding', () => {
  it('appends in order with unique ids', () => {
    const { added, refused } = store().add('c1', [fileDraft(1), fileDraft(2)])
    expect(refused).toBeNull()
    expect(added).toHaveLength(2)
    expect(list('c1').map(ref => ref.range?.startLine)).toEqual([1, 2])
    expect(new Set(list('c1').map(ref => ref.id)).size).toBe(2)
  })

  it('bounds quotes and notes when a reference enters', () => {
    const long = 'x'.repeat(REFERENCE_LIMITS.readableQuoteChars + 500)
    store().add('c1', [{ ...fileDraft(1, long), note: `  ${'n'.repeat(REFERENCE_LIMITS.noteChars + 10)}  ` }])
    const [ref] = list('c1')
    expect(ref.quote).toHaveLength(REFERENCE_LIMITS.readableQuoteChars)
    expect(ref.note).toHaveLength(REFERENCE_LIMITS.noteChars)
  })

  it('keeps the tail of long terminal output and the head of a chat passage', () => {
    const output = 'a'.repeat(REFERENCE_LIMITS.standaloneQuoteChars) + 'TAIL'
    store().add('c1', [
      { source: { kind: 'terminal', title: 'zsh' }, quote: output },
      { source: { kind: 'message', conversationId: 'c', messageId: 'm' }, quote: 'HEAD' + output },
    ])
    const [terminal, message] = list('c1')
    expect(terminal.quote?.endsWith('TAIL')).toBe(true)
    expect(message.quote?.startsWith('HEAD')).toBe(true)
    expect(terminal.quote).toHaveLength(REFERENCE_LIMITS.standaloneQuoteChars)
  })

  it('stops at the per-message limit and says why', () => {
    const many = Array.from({ length: REFERENCE_LIMITS.maxPerMessage + 3 }, (_, i) => fileDraft(i + 1))
    const { added, refused } = store().add('c1', many)
    expect(added).toHaveLength(REFERENCE_LIMITS.maxPerMessage)
    expect(refused).toBe('limit')
    expect(store().add('c1', [fileDraft(99)])).toEqual({ added: [], refused: 'limit' })
  })

  it('does not attach the same local path twice', () => {
    store().add('c1', [pathDraft('/tmp/a.pdf'), pathDraft('/tmp/a.pdf')])
    store().add('c1', [pathDraft('/tmp/a.pdf'), pathDraft('/tmp/b.pdf')])
    expect(list('c1').map(ref => ref.source.kind === 'path' && ref.source.path)).toEqual(['/tmp/a.pdf', '/tmp/b.pdf'])
  })

  it('keeps drafts of different composers apart', () => {
    store().add('c1', [fileDraft(1)])
    store().add('c2', [fileDraft(2)])
    expect(list('c1')).toHaveLength(1)
    expect(list('c2')[0].range?.startLine).toBe(2)
  })
})

describe('editing', () => {
  it('removing renumbers the rest by position', () => {
    store().add('c1', [fileDraft(1), fileDraft(2), fileDraft(3)])
    const second = list('c1')[1]
    store().remove('c1', second.id)
    expect(list('c1').map(ref => ref.range?.startLine)).toEqual([1, 3])
  })

  it('the last removal drops the draft entirely', () => {
    store().add('c1', [fileDraft(1)])
    store().remove('c1', list('c1')[0].id)
    expect(store().drafts.has('c1')).toBe(false)
  })

  it('updates a note in place, trimmed, and an empty note removes it', () => {
    store().add('c1', [fileDraft(1), fileDraft(2)])
    const [first] = list('c1')
    store().updateNote('c1', first.id, '  move this to router  ')
    expect(list('c1')[0].note).toBe('move this to router')
    expect(list('c1')[0].id).toBe(first.id)
    store().updateNote('c1', first.id, '   ')
    expect(list('c1')[0]).not.toHaveProperty('note')
  })

  it('leaves the list object alone when nothing changed', () => {
    store().add('c1', [fileDraft(1)])
    const before = store().drafts
    store().updateNote('c1', list('c1')[0].id, '')
    store().remove('c1', 'missing')
    expect(store().drafts).toBe(before)
  })
})

describe('sending', () => {
  it('take returns the list and empties the composer', () => {
    store().add('c1', [fileDraft(1), fileDraft(2)])
    const taken = store().take('c1')
    expect(taken.map(ref => ref.range?.startLine)).toEqual([1, 2])
    expect(store().drafts.has('c1')).toBe(false)
    expect(store().take('c1')).toEqual([])
  })

  it('a failed send puts the cards back ahead of cards added since', () => {
    store().add('c1', [fileDraft(1), fileDraft(2)])
    const taken = store().take('c1')
    store().add('c1', [fileDraft(3)])
    store().restore('c1', taken)
    expect(list('c1').map(ref => ref.range?.startLine)).toEqual([1, 2, 3])
  })

  it('restoring twice does not duplicate cards', () => {
    store().add('c1', [fileDraft(1)])
    const taken = store().take('c1')
    store().restore('c1', taken)
    store().restore('c1', taken)
    expect(list('c1')).toHaveLength(1)
  })
})

describe('the composer beside the canvas', () => {
  it('reads the target composer\'s list', () => {
    store().add('c1', [fileDraft(1)])
    expect(getTargetReferences()).toEqual([])
    store().setTarget({ key: 'c1', title: 'T', visible: true, reveal: () => {} })
    expect(getTargetReferences()).toHaveLength(1)
  })

  it('an equal target does not notify subscribers', () => {
    const reveal = () => {}
    store().setTarget({ key: 'c1', title: 'T', visible: true, reveal })
    const before = store().target
    store().setTarget({ key: 'c1', title: 'T', visible: true, reveal })
    expect(store().target).toBe(before)
  })

  it('composer signals are distinct even when repeated, and stay until handled', () => {
    store().signalComposer('c1', 'text')
    const first = store().signal
    store().signalComposer('c1', 'text')
    expect(store().signal?.seq).not.toBe(first?.seq)
    expect(store().signal).toMatchObject({ key: 'c1', focus: 'text' })
    store().consumeSignal(first!.seq)
    expect(store().signal).not.toBeNull()
    store().consumeSignal(store().signal!.seq)
    expect(store().signal).toBeNull()
  })
})
