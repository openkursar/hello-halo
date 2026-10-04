/**
 * A comment on a place in the content, read, edited and deleted where it was
 * written: the same card sits under the lines in an editor and floats beside
 * rendered text or terminal output.
 *
 * Whether it is open for writing, and what has been typed, live in
 * `comment-edits`, so a card that is rebuilt keeps both.
 */

import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from 'react'
import { MessageSquare } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useAppStore } from '../../stores/app.store'
import { useIsMobile } from '../../hooks/useIsMobile'
import { REFERENCE_LIMITS } from '../../../shared/types/content-reference'
import { setEditText, startEditing, stopEditing, useEditText } from './comment-edits'
import { claimCommentFocus, focusCommentIn } from './comment-focus'
import { IS_MAC } from './selection'

export interface CommentCardProps {
  /** The reference's id; a new comment's draft id. */
  id: string
  header: string
  /** The saved text; '' for a new comment. */
  note: string
  /** Called with the trimmed text; the caller decides what an empty one means. */
  onSave: (note: string) => void
  /** Existing comments only. */
  onDelete?: () => void
  /** A new comment: cancelling discards it. */
  onDiscard?: () => void
  /** Puts the caret in the text box when the card is open for writing. */
  autoFocus?: boolean
  /** The hidden twin that keeps a side-by-side diff aligned: the same size, nothing to see or reach. */
  ghost?: boolean
  className?: string
}

export function CommentCard({ id, header, note, onSave, onDelete, onDiscard, autoFocus = false, ghost = false, className = '' }: CommentCardProps) {
  const { t } = useTranslation()
  const text = useEditText(id)
  const editing = text !== null
  const rootRef = useRef<HTMLDivElement>(null)

  // Gone back to before it was there (its tab or editor still on the way): it takes the focus now.
  useEffect(() => {
    if (!ghost && rootRef.current && claimCommentFocus(id)) focusCommentIn(rootRef.current)
  }, [id, ghost])

  const edit = () => startEditing(id, note)
  const save = () => {
    const value = (text ?? '').trim()
    stopEditing(id)
    onSave(value)
  }
  const cancel = () => {
    stopEditing(id)
    onDiscard?.()
  }

  return (
    <div
      ref={rootRef}
      role={ghost ? undefined : 'group'}
      aria-label={ghost ? undefined : header}
      aria-hidden={ghost || undefined}
      data-comment-card={ghost ? undefined : id}
      className={`rounded-lg border border-border bg-card px-3 py-2 font-sans text-[13px] leading-snug text-foreground shadow-sm
        ${ghost ? 'invisible pointer-events-none' : ''} ${className}`}
    >
      <div className="flex min-h-[22px] items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <MessageSquare size={12} className="shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{header}</span>
        {!editing && (
          <>
            <button
              type="button"
              data-comment-edit=""
              onClick={edit}
              className="rounded px-1.5 py-0.5 hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            >
              {t('Edit')}
            </button>
            {onDelete && (
              <button
                type="button"
                onClick={onDelete}
                className="rounded px-1.5 py-0.5 hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              >
                {t('Delete')}
              </button>
            )}
          </>
        )}
      </div>
      {editing ? (
        <CommentEditor
          id={id}
          text={text}
          autoFocus={autoFocus && !ghost}
          onSave={save}
          onCancel={cancel}
        />
      ) : (
        <p onClick={edit} className="mt-1 cursor-text whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          {note}
        </p>
      )}
    </div>
  )
}

function CommentEditor({ id, text, autoFocus, onSave, onCancel }: {
  id: string
  text: string
  autoFocus: boolean
  onSave: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const sendKeyMode = useAppStore(state => state.config?.chat?.sendKeyMode ?? 'enter')
  const isMobile = useIsMobile()
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !autoFocus) return
    el.focus({ preventScroll: true })
    el.setSelectionRange(el.value.length, el.value.length)
  }, [autoFocus])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [text])

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Typing here is for the comment only: not the editor's keys, the view's shortcuts or the canvas.
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
      return
    }
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || isMobile) return
    const saves = sendKeyMode === 'ctrl-enter' ? (IS_MAC ? e.metaKey : e.ctrlKey) : !e.shiftKey
    if (!saves) return
    e.preventDefault()
    onSave()
  }

  return (
    <div className="mt-1.5">
      <textarea
        ref={ref}
        value={text}
        rows={2}
        maxLength={REFERENCE_LIMITS.noteChars}
        placeholder={t('Add a comment…')}
        aria-label={t('Comment')}
        onChange={e => setEditText(id, e.target.value)}
        onKeyDown={handleKeyDown}
        className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-[13px] leading-snug text-foreground
          placeholder:text-subtle-foreground focus:border-primary focus:outline-none"
      />
      <div className="mt-1.5 flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="h-7 rounded-md px-2.5 text-[12.5px] text-muted-foreground hover:bg-secondary hover:text-foreground
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          {t('Cancel')}
        </button>
        <button
          type="button"
          onClick={onSave}
          className="h-7 rounded-md bg-primary px-2.5 text-[12.5px] font-medium text-primary-foreground hover:bg-primary-hover
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          {t('Save')}
        </button>
      </div>
    </div>
  )
}
