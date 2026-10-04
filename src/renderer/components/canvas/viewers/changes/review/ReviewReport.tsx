/**
 * The review's report: the last reply of its conversation, rendered as the
 * chat renders replies. Its `path:line` mentions link to files, any passage
 * can be pointed at for the chat, and a followed link is remembered so coming
 * back points at it again.
 */

import { useCallback, useEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react'
import { MarkdownRenderer } from '../../../../chat/MarkdownRenderer'
import { FileLinkProvider, useTextReferences, type FileLinkTarget } from '../../../../references'
import { flashElement } from '../shared/flash'

const MENTION_SELECTOR = 'code[data-file-mention]'

interface ReviewReportProps {
  spaceId: string
  conversationId: string
  messageId: string
  content: string
  conversationTitle: string | null
  /**
   * A file link was followed; `mention` is its index among the report's file
   * mentions. Return false to let the file open in the canvas instead.
   */
  onOpenFile: (target: FileLinkTarget, mention: number) => boolean
  /** Mention to bring into view and point at, after coming back from a link. */
  returnTo: number | null
}

export function ReviewReport({ spaceId, conversationId, messageId, content, conversationTitle, onOpenFile, returnTo }: ReviewReportProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const followed = useRef(-1)
  const openFile = useRef(onOpenFile)
  openFile.current = onOpenFile

  useTextReferences(rootRef, {
    source: { kind: 'message', conversationId, messageId, ...(conversationTitle ? { conversationTitle } : {}) },
  })

  // Runs before the link's own handler (capture phase), which then calls `onOpen`.
  const noteMention = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    const code = (event.target as Element).closest?.(MENTION_SELECTOR)
    followed.current = code && rootRef.current ? [...rootRef.current.querySelectorAll(MENTION_SELECTOR)].indexOf(code) : -1
  }
  // Stable, so the links are not worked out again on every render.
  const onOpen = useCallback((target: FileLinkTarget) => openFile.current(target, followed.current), [])

  useEffect(() => {
    if (returnTo === null) return
    const code = rootRef.current?.querySelectorAll<HTMLElement>(MENTION_SELECTOR)[returnTo]
    if (!code) return
    const scroller = code.closest('[data-overview-scroll]')
    const box = scroller?.getBoundingClientRect()
    const rect = code.getBoundingClientRect()
    if (box && (rect.top < box.top || rect.bottom > box.bottom)) code.scrollIntoView({ block: 'center' })
    code.focus({ preventScroll: true })
    return flashElement(code)
  }, [returnTo])

  return (
    <FileLinkProvider spaceId={spaceId} onOpen={onOpen}>
      <div
        ref={rootRef}
        onClickCapture={noteMention}
        onKeyDownCapture={(event) => {
          if (event.key === 'Enter') noteMention(event)
        }}
        className="break-words text-[13.5px] leading-relaxed"
      >
        <MarkdownRenderer content={content} />
      </div>
    </FileLinkProvider>
  )
}
