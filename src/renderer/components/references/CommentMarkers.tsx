/**
 * Markers beside pending comments in rendered text; one opens its comment in
 * the floating card. They float over the page (the page's DOM is never
 * rewritten), line up in the text column's margin, follow scrolling, and hide
 * whenever the passage's start is not actually visible — scrolled away, or
 * covered by another layer. Nothing runs while there are none.
 */

import { useEffect, useMemo, useReducer } from 'react'
import { createPortal } from 'react-dom'
import { MessageSquare } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useTargetReferences } from '../../stores/composer-references.store'
import { useTextCommentMarks, type TextCommentMark } from './adapters/dom-text'
import { COMMENT_MARKER_ATTRIBUTE, openCommentCard } from './comment-markers'

/** Marker width plus its gap to the text. */
const MARKER_OFFSET = 20

/**
 * Where the text column starts (markers line up left of it, in its margin) and
 * how far left a marker may go before leaving the visible scroll area.
 */
interface Column {
  element: HTMLElement
  clip: HTMLElement | null
}

const columns = new WeakMap<HTMLElement, Column>()

function columnOf(mark: TextCommentMark): Column {
  const start = mark.range.startContainer
  const startElement = start.nodeType === Node.ELEMENT_NODE ? start as HTMLElement : start.parentElement
  const element = (startElement?.closest('.prose, .markdown-content') as HTMLElement | null) ?? mark.scope
  const known = columns.get(element)
  if (known) return known
  let clip: HTMLElement | null = element.parentElement
  while (clip && !/(auto|scroll|hidden)/.test(getComputedStyle(clip).overflowX)) clip = clip.parentElement
  const column = { element, clip }
  columns.set(element, column)
  return column
}

function placement(mark: TextCommentMark): { left: number; top: number } | null {
  if (!mark.range.startContainer.isConnected) return null
  const rect = mark.range.getClientRects()[0]
  if (!rect || (rect.width === 0 && rect.height === 0)) return null
  const hit = document.elementFromPoint(rect.left + 1, rect.top + rect.height / 2)
  if (!hit || !mark.scope.contains(hit)) return null
  // A column of markers in the margin, never over the text a passage starts in the middle of.
  const { element, clip } = columnOf(mark)
  const textLeft = element.getBoundingClientRect().left + (parseFloat(getComputedStyle(element).paddingLeft) || 0)
  const minLeft = (clip?.getBoundingClientRect().left ?? 0) + 2
  return { left: Math.max(minLeft, textLeft - MARKER_OFFSET), top: rect.top + 1 }
}

export function CommentMarkers() {
  const { t } = useTranslation()
  const marks = useTextCommentMarks(state => state.marks)
  const references = useTargetReferences()
  const notes = useMemo(() => new Map(references.map(ref => [ref.id, ref.note ?? ''])), [references])
  const [, reposition] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    if (marks.length === 0) return
    let frame = 0
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(reposition)
    }
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    // Layout can move a passage without any scroll (the chat column resized, the canvas opened).
    const resizeObserver = new ResizeObserver(schedule)
    for (const scope of new Set(marks.map(mark => mark.scope))) resizeObserver.observe(scope)
    return () => {
      cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
    }
  }, [marks])

  if (marks.length === 0) return null
  return createPortal(
    marks.map(mark => {
      const position = placement(mark)
      if (!position) return null
      return (
        <button
          key={mark.key}
          type="button"
          data-reference-layer=""
          {...{ [COMMENT_MARKER_ATTRIBUTE]: mark.id }}
          onMouseDown={e => e.preventDefault()}
          onClick={e => {
            const rect = e.currentTarget.getBoundingClientRect()
            openCommentCard(mark.id, { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })
          }}
          aria-label={t('Comment')}
          title={notes.get(mark.id) ?? ''}
          className="fixed z-[45] inline-flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          style={{ left: position.left, top: position.top }}
        >
          <MessageSquare size={9} aria-hidden />
        </button>
      )
    }),
    document.body,
  )
}
