/**
 * A comment gone back to for editing takes the focus in its card: at once
 * when the card is there, else when it mounts (its tab or editor was still on
 * the way), and again if a rebuilt card mounts after the focus was lost with
 * the old one. No card in time hands the comment to the fallback; the user
 * clicking or typing ends the request, so a late card never takes the focus
 * away from them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claimCommentFocus, focusCommentIn, requestCommentFocus } from '../../../../src/renderer/components/references/comment-focus'

type Listener = () => void

const page = {
  cards: new Map<string, ReturnType<typeof card>>(),
  listeners: new Map<string, Set<Listener>>(),
  /** The comment whose card holds the focus, if any. */
  focusedIn: null as string | null,
}

/** A comment card: open for writing (a text box) or not (an Edit button). */
function card(writing = false) {
  const target = { focus: vi.fn() }
  return {
    target,
    querySelector: (selector: string) => (selector.includes(writing ? 'textarea' : '[data-comment-edit]') ? target : null),
  }
}

function userDoes(type: 'pointerdown' | 'keydown') {
  for (const listener of [...(page.listeners.get(type) ?? [])]) listener()
}

beforeEach(() => {
  vi.useFakeTimers()
  page.cards.clear()
  page.listeners.clear()
  page.focusedIn = null
  vi.stubGlobal('CSS', { escape: (value: string) => value })
  vi.stubGlobal('document', {
    querySelector: (selector: string) => {
      const id = /data-comment-card="([^"]+)"/.exec(selector)?.[1]
      return id ? page.cards.get(id) ?? null : null
    },
    get activeElement() {
      return { closest: (selector: string) => (page.focusedIn && selector.includes(`"${page.focusedIn}"`) ? {} : null) }
    },
  })
  vi.stubGlobal('window', {
    addEventListener: (type: string, listener: Listener) => {
      if (!page.listeners.has(type)) page.listeners.set(type, new Set())
      page.listeners.get(type)!.add(listener)
    },
    removeEventListener: (type: string, listener: Listener) => page.listeners.get(type)?.delete(listener),
  })
})

afterEach(() => {
  userDoes('keydown')
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('requestCommentFocus', () => {
  it('focuses a card that is already there: its Edit button, or its text box while it is being written', () => {
    const shown = card()
    page.cards.set('ref-1', shown)
    const otherwise = vi.fn()
    requestCommentFocus('ref-1', otherwise)
    expect(shown.target.focus).toHaveBeenCalledWith({ preventScroll: true })
    vi.advanceTimersByTime(10_000)
    expect(otherwise).not.toHaveBeenCalled()

    const writing = card(true)
    focusCommentIn(writing as unknown as HTMLElement)
    expect(writing.target.focus).toHaveBeenCalled()
  })

  it('waits for a card still on the way, which takes the focus as it mounts', () => {
    const otherwise = vi.fn()
    requestCommentFocus('ref-1', otherwise)
    expect(claimCommentFocus('ref-2')).toBe(false)
    expect(claimCommentFocus('ref-1')).toBe(true)
    vi.advanceTimersByTime(10_000)
    expect(otherwise).not.toHaveBeenCalled()
    expect(claimCommentFocus('ref-1')).toBe(false)
  })

  it('a card rebuilt while the view settles takes the focus back only if it was lost', () => {
    requestCommentFocus('ref-1', vi.fn())
    expect(claimCommentFocus('ref-1')).toBe(true)
    page.focusedIn = 'ref-1'
    expect(claimCommentFocus('ref-1')).toBe(false)
    page.focusedIn = null
    expect(claimCommentFocus('ref-1')).toBe(true)
  })

  it('hands the comment to the fallback when no card mounts in time', () => {
    const otherwise = vi.fn()
    requestCommentFocus('ref-1', otherwise)
    vi.advanceTimersByTime(4_999)
    expect(otherwise).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(otherwise).toHaveBeenCalledOnce()
    expect(claimCommentFocus('ref-1')).toBe(false)
  })

  it('ends when the user clicks or types meanwhile: no late focus, no fallback', () => {
    for (const action of ['pointerdown', 'keydown'] as const) {
      const otherwise = vi.fn()
      requestCommentFocus('ref-1', otherwise)
      userDoes(action)
      expect(claimCommentFocus('ref-1')).toBe(false)
      vi.advanceTimersByTime(10_000)
      expect(otherwise).not.toHaveBeenCalled()
    }
    expect([...page.listeners.values()].every(set => set.size === 0)).toBe(true)
  })

  it('a newer request replaces the one waiting', () => {
    const first = vi.fn()
    requestCommentFocus('ref-1', first)
    requestCommentFocus('ref-2', vi.fn())
    expect(claimCommentFocus('ref-1')).toBe(false)
    expect(claimCommentFocus('ref-2')).toBe(true)
    vi.advanceTimersByTime(10_000)
    expect(first).not.toHaveBeenCalled()
  })
})
