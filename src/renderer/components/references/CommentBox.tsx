/**
 * The comment box: one instruction for the selected place, written where the
 * user is looking. Adding keeps the reader in the content (the card goes to
 * the composer without taking the caret).
 *
 * Esc is handled by the reference layer, which owns the keyboard while the
 * box is open; Enter follows the user's send-key setting, so the composer and
 * this box submit the same way.
 */

import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from '../../i18n'
import { useAppStore } from '../../stores/app.store'
import { useIsMobile } from '../../hooks/useIsMobile'
import { REFERENCE_LIMITS } from '../../../shared/types/content-reference'
import { IS_MAC, type SelectionRect } from './selection'
import { placeUnder } from './SelectionBar'
import { ReferenceKindIcon, referenceLabel, type ReferenceLike } from './reference-display'

/** Characters left before the counter appears. */
const COUNTER_FROM = REFERENCE_LIMITS.noteChars - 200

interface CommentBoxProps {
  draft: ReferenceLike
  rect: SelectionRect
  onAdd: (note: string) => void
  onCancel: () => void
}

export function CommentBox({ draft, rect, onAdd, onCancel }: CommentBoxProps) {
  const { t, i18n } = useTranslation()
  const sendKeyMode = useAppStore(state => state.config?.chat?.sendKeyMode ?? 'enter')
  const isMobile = useIsMobile()
  const ref = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [note, setNote] = useState('')
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    textareaRef.current?.focus()
  }, [])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || isMobile) return
    setPosition(placeUnder(rect, el.offsetWidth, el.offsetHeight))
  }, [rect, isMobile])

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || isMobile) return
    const submits = sendKeyMode === 'ctrl-enter' ? (IS_MAC ? e.metaKey : e.ctrlKey) : !e.shiftKey
    if (!submits) return
    e.preventDefault()
    onAdd(note)
  }

  const addKey = sendKeyMode === 'ctrl-enter' ? (IS_MAC ? '⌘↵' : 'Ctrl+↵') : '↵'
  const newlineKey = sendKeyMode === 'ctrl-enter' ? '↵' : '⇧↵'
  const formatCount = (value: number) => new Intl.NumberFormat(i18n.language).format(value)

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t('Comment')}
      data-reference-layer=""
      className="fixed z-[61] inset-x-2 bottom-2 sm:inset-x-auto sm:bottom-auto sm:w-[360px]
        rounded-[10px] border border-border bg-popover p-2 shadow-pop animate-pop-in"
      style={isMobile ? undefined : position ? { left: position.left, top: position.top } : { left: -9999, top: -9999 }}
    >
      <div className="mb-1.5 flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <ReferenceKindIcon reference={draft} />
        <span className="truncate font-mono">{referenceLabel(draft, t)}</span>
      </div>
      <textarea
        ref={textareaRef}
        value={note}
        onChange={e => setNote(e.target.value)}
        onKeyDown={handleKeyDown}
        maxLength={REFERENCE_LIMITS.noteChars}
        rows={3}
        placeholder={t('Comment for the AI…')}
        aria-label={t('Comment for the AI…')}
        className="block w-full resize-none rounded-[7px] border border-border bg-background px-2 py-1.5 text-[13px]
          leading-relaxed text-foreground placeholder:text-subtle-foreground focus:border-primary focus:outline-none"
      />
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className="hidden min-w-0 text-[11.5px] leading-snug text-subtle-foreground sm:inline">
          {t('{{add}} to add · {{newline}} for a new line', { add: addKey, newline: newlineKey })}
        </span>
        {note.length >= COUNTER_FROM && (
          <span className="shrink-0 text-[11.5px] tabular-nums text-subtle-foreground" aria-live="polite">
            {t('{{used}}/{{max}}', { used: formatCount(note.length), max: formatCount(REFERENCE_LIMITS.noteChars) })}
          </span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          className="h-9 sm:h-7 rounded-md px-2.5 text-[12.5px] text-muted-foreground transition-colors ease-halo hover:bg-secondary hover:text-foreground"
        >
          {t('Cancel')}
        </button>
        <button
          type="button"
          onClick={() => onAdd(note)}
          className="h-9 sm:h-7 rounded-md bg-primary px-3 text-[12.5px] font-medium text-primary-foreground transition-colors ease-halo hover:bg-primary-hover"
        >
          {t('Add')}
        </button>
      </div>
    </div>
  )
}
