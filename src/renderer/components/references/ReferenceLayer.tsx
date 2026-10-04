/**
 * The reference layer of a page that places a chat beside content: it names
 * that chat's composer as the place references go, listens for selections in
 * rendered text, and shows the floating bar, the comment box, the comment
 * markers of rendered text and the floating comment card. Mount it once, on
 * such a page only — where it is absent (e.g. the knowledge base) no
 * selection is ever offered.
 *
 * While the bar, the comment box or a floating comment is up, the layer owns
 * Esc (and ⌘L/Ctrl+L for the bar) at the window (capture phase), so a key
 * closes only the topmost layer and never reaches the canvas or the composer
 * underneath.
 */

import { useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useComposerReferencesStore } from '../../stores/composer-references.store'
import { addReference } from './add-reference'
import { listenForTextSelections } from './adapters/dom-text'
import { CommentBox } from './CommentBox'
import { CommentMarkers } from './CommentMarkers'
import { FloatingCommentCard } from './FloatingCommentCard'
import { SelectionBar } from './SelectionBar'
import {
  closeComment,
  dismissOffer,
  isAddShortcut,
  openComment,
  setPointerDown,
  useSelectionStore,
  viewComment,
  type OfferedSelection,
} from './selection'

export interface ReferenceLayerProps {
  /** The conversation shown beside the content; null while there is none. */
  conversationId: string | null
  conversationTitle: string
  /** Whether that conversation's composer is on screen (not behind a maximized or full-screen canvas). */
  composerVisible: boolean
  /** Brings the composer on screen. */
  onRevealComposer: () => void
}

function addOffered(offered: OfferedSelection): void {
  addReference(offered.draft, { focusComposer: true })
  offered.collapse?.()
  dismissOffer()
}

export function ReferenceLayer({ conversationId, conversationTitle, composerVisible, onRevealComposer }: ReferenceLayerProps) {
  const offered = useSelectionStore(state => state.offered)
  const commenting = useSelectionStore(state => state.commenting)
  const viewing = useSelectionStore(state => state.viewing)

  const revealRef = useRef(onRevealComposer)
  revealRef.current = onRevealComposer
  const reveal = useCallback(() => revealRef.current(), [])

  useEffect(() => {
    useComposerReferencesStore.getState().setTarget(
      conversationId ? { key: conversationId, title: conversationTitle, visible: composerVisible, reveal } : null,
    )
  }, [conversationId, conversationTitle, composerVisible, reveal])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      setPointerDown(true)
      const target = event.target as Element | null
      if (!target?.closest?.('[data-reference-layer]')) dismissOffer()
    }
    const onPointerUp = () => setPointerDown(false)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('pointercancel', onPointerUp, true)
    const stopTextSelections = listenForTextSelections()
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('pointercancel', onPointerUp, true)
      stopTextSelections()
      setPointerDown(false)
      useSelectionStore.setState({ offered: null, commenting: null, viewing: null })
      useComposerReferencesStore.getState().setTarget(null)
    }
  }, [])

  const active = !!offered || !!commenting || !!viewing
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      const { offered: current, commenting: open, viewing: shown } = useSelectionStore.getState()
      if (event.key === 'Escape') {
        // A floating comment handles the keys typed into it itself.
        if (shown && !(event.target as Element | null)?.closest?.('[data-reference-layer]')) {
          event.preventDefault()
          event.stopPropagation()
          viewComment(null)
          return
        }
        if (!open && !current) return
        event.preventDefault()
        event.stopPropagation()
        if (open) {
          closeComment()
          open.refocus?.(true)
        } else {
          dismissOffer()
        }
        return
      }
      if (current && !open && isAddShortcut(event)) {
        event.preventDefault()
        event.stopPropagation()
        addOffered(current)
      }
    }
    const onScroll = (event: Event) => {
      const target = event.target as Element | null
      if (target?.closest?.('[data-reference-layer]')) return
      dismissOffer()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [active])

  return (
    <>
      <CommentMarkers />
      <FloatingCommentCard />
      {offered && !commenting && createPortal(
        <SelectionBar rect={offered.rect} onComment={openComment} onAdd={() => addOffered(offered)} />,
        document.body,
      )}
      {commenting && createPortal(
        <CommentBox
          key={`${commenting.rect.left}:${commenting.rect.top}`}
          draft={commenting.draft}
          rect={commenting.rect}
          onAdd={(note) => {
            closeComment()
            addReference({ ...commenting.draft, note }, { focusComposer: false })
            commenting.collapse?.()
            commenting.refocus?.(false)
          }}
          onCancel={() => {
            closeComment()
            commenting.refocus?.(true)
          }}
        />,
        document.body,
      )}
    </>
  )
}
