/**
 * The conversation list follows the open conversation: when one is opened from
 * elsewhere (a conversation link, search, the task panel, another space), its
 * row is scrolled into view and highlighted.
 *
 * The row is found by id in the rows the list already holds and reached through
 * the virtual list's scroll-to-index, so nothing in between is rendered and the
 * cost does not grow with the list. The request is one-shot: once the row has
 * been reached, later reorders of the list never move it again.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { VirtuosoHandle } from 'react-virtuoso'
import type { ConversationSection } from '../../stores/conversation-list-prefs.store'

/** One pane's rows as the list draws them, and whether its section is open. */
export interface RevealPane {
  rows: readonly { key: string }[]
  open: boolean
}

export type RevealPanes = Record<ConversationSection, RevealPane>

export type RevealStep =
  /** The row's section is folded: open it for now, then look again. */
  | { type: 'open'; section: ConversationSection }
  | { type: 'row'; section: ConversationSection; index: number }
  /** The list is folded to its icon strip. */
  | { type: 'dot'; index: number }

const SECTIONS: readonly ConversationSection[] = ['pinned', 'digital-humans', 'conversations']

/**
 * The next step towards showing conversation `id`, or `null` while the list
 * does not draw it (still loading, its digital human's group still opening,
 * or not a conversation this list shows).
 */
export function planReveal(
  id: string,
  panes: RevealPanes,
  strip: readonly { key: string }[] | null,
): RevealStep | null {
  for (const section of SECTIONS) {
    const pane = panes[section]
    const index = pane.rows.findIndex(row => row.key === id)
    if (index < 0) continue
    if (!pane.open) return { type: 'open', section }
    if (!strip) return { type: 'row', section, index }
    const dot = strip.findIndex(row => row.key === id)
    return dot < 0 ? null : { type: 'dot', index: dot }
  }
  return null
}

/** Scrolls only `container`, never its ancestors, and only when `child` is not fully in view. */
function scrollChildIntoView(container: HTMLElement, child: Element): void {
  const box = container.getBoundingClientRect()
  const rect = child.getBoundingClientRect()
  if (rect.top < box.top) container.scrollTop += rect.top - box.top
  else if (rect.bottom > box.bottom) container.scrollTop += rect.bottom - box.bottom
}

/**
 * Frames a row is aimed at again after the first try. A list that has just
 * mounted or received rows may not have laid them out yet, which cuts the first
 * scroll short; a row already in view is left alone, so a repeat never moves it.
 */
const SETTLE_FRAMES = 2

interface RevealOptions {
  spaceId: string
  /** The conversation on screen. */
  conversationId: string | undefined
  panes: RevealPanes
  /** The icon strip's rows, in drawing order; `null` while the list is open. */
  strip: readonly { key: string }[] | null
  /** Open a folded section without touching the user's saved fold choice. */
  openSection: (section: ConversationSection) => void
}

/**
 * Brings the open conversation into view whenever it changes, and whenever the
 * list appears or switches between open and folded. A row the user picked in
 * the list itself is already in view, so the list stays still.
 */
export function useConversationReveal({ spaceId, conversationId, panes, strip, openSection }: RevealOptions) {
  const latest = useRef({ conversationId, panes, strip, openSection })
  const pending = useRef<string | null>(null)
  // Bumped whenever a new conversation is to be shown, ending an earlier row's settling.
  const request = useRef(0)
  const pickedHere = useRef<string | null>(null)
  const lists = useRef(new Map<ConversationSection, VirtuosoHandle>())
  // A virtual list placed before it has measured its viewport would aim at a zero-height view.
  const measured = useRef(new Set<ConversationSection>())
  const stripRef = useRef<HTMLDivElement>(null)

  const reveal = useCallback(() => {
    const id = pending.current
    if (!id) return
    const step = planReveal(id, latest.current.panes, latest.current.strip)
    if (!step) return
    if (step.type === 'open') {
      latest.current.openSection(step.section)
      return
    }
    if (step.type === 'dot') {
      const column = stripRef.current
      const dot = column?.children[step.index]
      if (!column || !dot) return
      scrollChildIntoView(column, dot)
    } else {
      const { section, index } = step
      if (!lists.current.has(section) || !measured.current.has(section)) return
      const current = request.current
      let frames = 0
      const aim = () => {
        if (request.current !== current) return
        lists.current.get(section)?.scrollIntoView({ index, behavior: 'auto' })
        if (frames++ < SETTLE_FRAMES) requestAnimationFrame(aim)
      }
      aim()
    }
    pending.current = null
  }, [])

  // Virtuoso hands out a new handle on every render of its own, so the handle
  // ref says nothing about mounting; its scroller ref is called once each way.
  const [listProps] = useState(() => {
    const propsFor = (section: ConversationSection) => ({
      ref: (handle: VirtuosoHandle | null) => {
        if (handle) lists.current.set(section, handle)
        else lists.current.delete(section)
      },
      scrollerRef: (scroller: HTMLElement | Window | null) => {
        if (!scroller) measured.current.delete(section)
      },
    })
    return { pinned: propsFor('pinned'), 'digital-humans': propsFor('digital-humans'), conversations: propsFor('conversations') }
  })

  const listMeasured = useCallback((section: ConversationSection) => {
    if (measured.current.has(section)) return
    measured.current.add(section)
    reveal()
  }, [reveal])

  const pickedInList = useCallback((id: string) => {
    if (id !== latest.current.conversationId) pickedHere.current = id
  }, [])

  useEffect(() => {
    latest.current = { conversationId, panes, strip, openSection }
  })

  const folded = strip !== null
  useEffect(() => {
    const picked = pickedHere.current === conversationId
    pickedHere.current = null
    pending.current = conversationId && !picked ? conversationId : null
    request.current++
  }, [spaceId, conversationId, folded])

  const { pinned, 'digital-humans': digitalHumans, conversations } = panes
  useEffect(reveal, [
    reveal, spaceId, conversationId, strip,
    pinned.rows, pinned.open, digitalHumans.rows, digitalHumans.open, conversations.rows, conversations.open,
  ])

  return { listProps, listMeasured, stripRef, pickedInList }
}
