/**
 * A pending comment opened outside an editor — from its marker in rendered
 * text, gone back to in a terminal, or beside the composer when its place
 * cannot be shown — in a floating card, where it is read, edited and deleted
 * like the cards under editor lines. The comment is looked up in whichever
 * composer holds it: going back to a message can switch the conversation.
 */

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '../../i18n'
import { findReference, useComposerReferencesStore } from '../../stores/composer-references.store'
import { CommentCard } from './CommentCard'
import { COMMENT_MARKER_ATTRIBUTE } from './comment-markers'
import { commentHeader } from './reference-display'
import { useSelectionStore, viewComment } from './selection'

const GAP = 6
const MARGIN = 8

export function FloatingCommentCard() {
  const { t } = useTranslation()
  const viewing = useSelectionStore(state => state.viewing)
  const reference = useComposerReferencesStore(state => (viewing ? findReference(state.drafts, viewing.id)?.reference : undefined))
  const panelRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  // Deleted, or saved empty (no longer a comment): nothing left to show.
  useEffect(() => {
    if (viewing && !reference?.note) viewComment(null)
  }, [viewing, reference])

  useLayoutEffect(() => {
    const panel = panelRef.current?.getBoundingClientRect()
    if (!viewing || !panel) {
      setPosition(null)
      return
    }
    const { rect } = viewing
    const below = rect.bottom + GAP
    const top = below + panel.height <= window.innerHeight - MARGIN ? below : Math.max(MARGIN, rect.top - panel.height - GAP)
    const left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - panel.width - MARGIN))
    setPosition({ left, top })
  }, [viewing])

  useEffect(() => {
    if (!viewing?.focus || !position) return
    panelRef.current?.querySelector<HTMLElement>('textarea, [data-comment-edit]')?.focus({ preventScroll: true })
  }, [viewing, position])

  useEffect(() => {
    if (!viewing) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (panelRef.current?.contains(target) || target?.closest?.(`[${COMMENT_MARKER_ATTRIBUTE}]`)) return
      viewComment(null)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [viewing])

  if (!viewing || !reference?.note) return null

  const save = (note: string) => {
    const { drafts, updateNote } = useComposerReferencesStore.getState()
    const owner = findReference(drafts, reference.id)
    if (owner) updateNote(owner.key, reference.id, note)
  }
  const remove = () => {
    const { drafts, remove: removeReference } = useComposerReferencesStore.getState()
    const owner = findReference(drafts, reference.id)
    if (owner) removeReference(owner.key, reference.id)
  }
  // The text box takes Esc while editing; otherwise it closes the card, and nothing under it.
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    viewComment(null)
  }

  return createPortal(
    <div
      ref={panelRef}
      data-reference-layer=""
      role="dialog"
      aria-label={t('Comment')}
      onKeyDown={handleKeyDown}
      className={`fixed z-50 w-[min(92vw,340px)] ${position ? 'animate-pop-in' : 'opacity-0'}`}
      style={position ?? { left: 0, top: 0 }}
    >
      <CommentCard
        id={reference.id}
        header={commentHeader(reference, t)}
        note={reference.note}
        onSave={save}
        onDelete={remove}
        className="shadow-pop"
      />
    </div>,
    document.body,
  )
}
