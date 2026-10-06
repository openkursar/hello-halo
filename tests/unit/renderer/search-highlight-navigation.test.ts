/**
 * The search highlight bar's keys and steps: arrows and Esc stay with a text
 * field or a widget that already used them, and ↑/↓ land where the bar's
 * buttons do — within the results of the conversation on screen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchResult } from '../../../src/shared/types/search'
import { highlightBarCommand } from '../../../src/renderer/components/search/highlight-bar-keys'
import { conversationResults, useSearchStore } from '../../../src/renderer/stores/search.store'

type Target = { tagName: string; isContentEditable?: boolean } | null

function press(key: string, target: Target = { tagName: 'BODY' }, modifiers: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return { key, target, metaKey: false, ctrlKey: false, shiftKey: false, defaultPrevented: false, ...modifiers } as unknown as KeyboardEvent
}

describe('keys while the highlight bar shows', () => {
  it('leaves arrows and Esc to text fields and editable regions', () => {
    for (const target of [{ tagName: 'TEXTAREA' }, { tagName: 'INPUT' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }]) {
      for (const key of ['ArrowUp', 'ArrowDown', 'Escape']) {
        expect(highlightBarCommand(press(key, target), true), `${key} in ${target.tagName}`).toBeNull()
      }
    }
  })

  it('leaves keys that a focused widget already handled', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'Escape']) {
      expect(highlightBarCommand(press(key, { tagName: 'DIV' }, { defaultPrevented: true }), true), key).toBeNull()
    }
  })

  it('steps and closes when nothing editable has focus', () => {
    for (const target of [{ tagName: 'BODY' }, { tagName: 'BUTTON' }, { tagName: 'DIV', isContentEditable: false }, null]) {
      expect(highlightBarCommand(press('ArrowUp', target), false)).toBe('earlier')
      expect(highlightBarCommand(press('ArrowDown', target), false)).toBe('more-recent')
      expect(highlightBarCommand(press('Escape', target), false)).toBe('close')
    }
    expect(highlightBarCommand(press('Enter'), false)).toBeNull()
  })

  it('keeps ⌘K / Ctrl+K editing the search wherever the focus is', () => {
    const textarea = { tagName: 'TEXTAREA' }
    expect(highlightBarCommand(press('k', textarea, { metaKey: true }), true)).toBe('edit')
    expect(highlightBarCommand(press('k', textarea, { ctrlKey: true }), false)).toBe('edit')
    expect(highlightBarCommand(press('k', textarea, { ctrlKey: true }), true)).toBeNull()
    expect(highlightBarCommand(press('k', textarea, { metaKey: true, shiftKey: true }), true)).toBeNull()
  })
})

function result(conversationId: string, messageId: string, spaceId = 'space-1'): SearchResult {
  return {
    kind: 'chat', conversationId, conversationTitle: conversationId, messageId, spaceId, spaceName: spaceId,
    messageRole: 'user', messageContent: 'match', messageTimestamp: '2026-10-06T00:00:00.000Z', matchCount: 1,
  }
}

describe('stepping through highlight results', () => {
  // Newest first, two conversations in different spaces interleaved.
  const results = [result('a', 'a1'), result('b', 'b1', 'space-2'), result('a', 'a2'), result('b', 'b2', 'space-2'), result('a', 'a3')]
  let navigated: Array<{ conversationId: string; messageId: string }>

  beforeEach(() => {
    vi.stubGlobal('window', new EventTarget())
    navigated = []
    window.addEventListener('search:navigate-to-result', event => { navigated.push((event as CustomEvent).detail) })
    useSearchStore.getState().showHighlightBar('match', results, 0)
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('stays within the conversation on screen, circularly, in both directions', () => {
    const { stepResult } = useSearchStore.getState()
    stepResult('earlier', 'a')
    stepResult('earlier', 'a')
    stepResult('earlier', 'a')
    stepResult('more-recent', 'a')
    expect(navigated.map(target => target.messageId)).toEqual(['a2', 'a3', 'a1', 'a3'])
    expect(navigated.every(target => target.conversationId === 'a')).toBe(true)
    expect(useSearchStore.getState().currentResultIndex).toBe(4)
  })

  it('steps through every result when the conversation on screen has none, as the bar counts them', () => {
    useSearchStore.getState().stepResult('earlier', 'elsewhere')
    expect(navigated.map(target => target.messageId)).toEqual(['b1'])
    expect(conversationResults(results, 'elsewhere').map(entry => entry.originalIndex)).toEqual([0, 1, 2, 3, 4])
    expect(conversationResults(results, null).map(entry => entry.originalIndex)).toEqual([0, 1, 2, 3, 4])
    expect(conversationResults(results, 'b').map(entry => entry.originalIndex)).toEqual([1, 3])
  })

  it('does not move when the conversation holds a single result', () => {
    useSearchStore.getState().showHighlightBar('match', [result('a', 'a1'), result('b', 'b1')], 0)
    useSearchStore.getState().stepResult('earlier', 'a')
    useSearchStore.getState().stepResult('more-recent', 'a')
    expect(navigated).toEqual([])
  })
})
