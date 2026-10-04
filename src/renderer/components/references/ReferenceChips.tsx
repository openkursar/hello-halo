/**
 * The references of a message as a few chips, the way attachments always were:
 * one for the comments, one for the selections (passages added without a
 * comment), and one per attached file or folder. A group chip opens the list
 * of what it holds — on hover or click, as a sheet from the bottom on a phone
 * — and a row there goes back to the place.
 *
 * In the composer a group's × removes the whole group (with Undo) and a row's
 * × removes one; in the transcript the chips only show.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { FileText, Folder, MessageSquare, TextQuote, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import { isElectron } from '../../api/transport'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useComposerReferencesStore } from '../../stores/composer-references.store'
import { useNotificationStore } from '../../stores/notification.store'
import { attachedPathName } from '../../../shared/attached-paths'
import type { ContentReference } from '../../../shared/types/content-reference'
import { quoteFirstLine, ReferenceKindIcon, referenceLabel, referenceTooltip } from './reference-display'
import { revealReference } from './reveal'

type GroupKind = 'comments' | 'selections'

export interface ReferenceGroups {
  /** References carrying a note. */
  comments: ContentReference[]
  /** References without one: passages, terminal output, a whole report. */
  selections: ContentReference[]
  /** Attached files and folders, a chip each. */
  files: ContentReference[]
}

export function groupReferences(references: readonly ContentReference[]): ReferenceGroups {
  const groups: ReferenceGroups = { comments: [], selections: [], files: [] }
  for (const ref of references) {
    if (ref.source.kind === 'path') groups.files.push(ref)
    else if (ref.note) groups.comments.push(ref)
    else groups.selections.push(ref)
  }
  return groups
}

const REMOVED_NOTICE_ID = 'composer-references-removed'
const HOVER_OPEN_MS = 150
const HOVER_CLOSE_MS = 150

const CHIP = 'group relative inline-flex max-w-[240px] items-center rounded-lg border border-border/70 bg-background/60 text-[12.5px] leading-none text-foreground animate-fade-in'
const CHIP_BODY = 'inline-flex min-w-0 items-center gap-1.5 h-7 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50'
// Seen on hover or focus on a desktop, always on a phone; the touch target reaches 36px past the 18px glyph.
const REMOVE = `relative mr-1 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md text-muted-foreground
  before:absolute before:-inset-[9px] before:content-[''] sm:before:hidden hover:bg-secondary hover:text-foreground
  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50
  sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100`

// ============================================
// Composer and transcript
// ============================================

interface ComposerReferenceChipsProps {
  /** The composer's draft key, where its references live. */
  composerKey: string
  references: readonly ContentReference[]
  /** Paths inside it are shown relative to it in tooltips. */
  baseDir?: string
  className?: string
}

export const ComposerReferenceChips = memo(function ComposerReferenceChips({ composerKey, references, baseDir, className = '' }: ComposerReferenceChipsProps) {
  const { t } = useTranslation()
  const groups = useMemo(() => groupReferences(references), [references])

  const removeOne = useCallback((ref: ContentReference) => {
    useComposerReferencesStore.getState().remove(composerKey, ref.id)
  }, [composerKey])
  const removeGroup = useCallback((kind: GroupKind, refs: readonly ContentReference[]) => {
    const undo = useComposerReferencesStore.getState().removeMany(composerKey, refs.map(ref => ref.id))
    const count = refs.length
    useNotificationStore.getState().show({
      id: REMOVED_NOTICE_ID,
      title: kind === 'comments' ? t('Removed {{count}} comments', { count }) : t('Removed {{count}} selections', { count }),
      variant: 'default',
      duration: 6000,
      action: { label: t('Undo'), onClick: undo },
    })
  }, [composerKey, t])
  // A comment is gone back to for editing, so its card takes the focus; a selection is only shown.
  const reveal = useCallback((ref: ContentReference) => {
    void revealReference(ref, ref.note ? { focusComment: true } : { keepFocus: true })
  }, [])

  if (references.length === 0) return null
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      {(['comments', 'selections'] as const).map(kind => groups[kind].length > 0 && (
        <GroupChip
          key={kind}
          kind={kind}
          references={groups[kind]}
          baseDir={baseDir}
          bumps
          composerKey={kind === 'comments' ? composerKey : undefined}
          onReveal={reveal}
          onRemoveOne={removeOne}
          onRemoveGroup={() => removeGroup(kind, groups[kind])}
        />
      ))}
      {groups.files.map(ref => <FileChip key={ref.id} reference={ref} onRemove={() => removeOne(ref)} />)}
    </div>
  )
})

interface MessageReferenceChipsProps {
  references: readonly ContentReference[]
  baseDir?: string
  className?: string
}

/** The references a sent message carried, read-only. */
export const MessageReferenceChips = memo(function MessageReferenceChips({ references, baseDir, className = '' }: MessageReferenceChipsProps) {
  const groups = useMemo(() => groupReferences(references), [references])
  const reveal = useCallback((ref: ContentReference) => {
    void revealReference(ref)
  }, [])
  if (references.length === 0) return null
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      {(['comments', 'selections'] as const).map(kind => groups[kind].length > 0 && (
        <GroupChip key={kind} kind={kind} references={groups[kind]} baseDir={baseDir} onReveal={reveal} />
      ))}
      {groups.files.map(ref => <FileChip key={ref.id} reference={ref} />)}
    </div>
  )
})

// ============================================
// Chips
// ============================================

function FileChip({ reference, onRemove }: { reference: ContentReference; onRemove?: () => void }) {
  const { t } = useTranslation()
  if (reference.source.kind !== 'path') return null
  const { path, isDirectory } = reference.source
  const name = attachedPathName(path)
  const Icon = isDirectory ? Folder : FileText
  const body = (
    <>
      <Icon size={13} className="shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">{name}</span>
    </>
  )
  return (
    <span title={path} className={CHIP}>
      {!onRemove && isElectron() ? (
        <button type="button" onClick={() => void api.showArtifactInFolder(path)} className={`${CHIP_BODY} px-2 hover:bg-secondary transition-colors`}>
          {body}
        </button>
      ) : (
        <span className={`${CHIP_BODY} ${onRemove ? 'pl-2 pr-1' : 'px-2'}`}>{body}</span>
      )}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={t('Remove {{name}}', { name })} className={REMOVE}>
          <X size={12} aria-hidden />
        </button>
      )}
    </span>
  )
}

interface GroupChipProps {
  kind: GroupKind
  references: readonly ContentReference[]
  baseDir?: string
  /** The count bumps when the group grows (the composer, as references arrive). */
  bumps?: boolean
  /** The composer's comments chip: a comment whose place cannot be shown opens beside it. */
  composerKey?: string
  onReveal: (ref: ContentReference) => void
  onRemoveOne?: (ref: ContentReference) => void
  onRemoveGroup?: () => void
}

type OpenState = null | { by: 'hover' | 'pin'; focusFirst: boolean }

function GroupChip({ kind, references, baseDir, bumps = false, composerKey, onReveal, onRemoveOne, onRemoveGroup }: GroupChipProps) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const chipRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState<OpenState>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const count = references.length
  const label = kind === 'comments' ? t('{{count}} comments', { count }) : t('{{count}} selections', { count })

  // The count bumps when the group grows, not when it first appears.
  const shown = useRef(count)
  const [bump, setBump] = useState(0)
  useLayoutEffect(() => {
    if (bumps && count > shown.current) setBump(value => value + 1)
    shown.current = count
  }, [bumps, count])

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => clearTimer, [])

  const hoverIn = (pointerType: string) => {
    if (pointerType !== 'mouse' || isMobile) return
    clearTimer()
    if (!open) timer.current = setTimeout(() => setOpen({ by: 'hover', focusFirst: false }), HOVER_OPEN_MS)
  }
  const hoverOut = (pointerType: string) => {
    if (pointerType !== 'mouse') return
    clearTimer()
    if (open?.by === 'hover') timer.current = setTimeout(() => setOpen(null), HOVER_CLOSE_MS)
  }
  const close = useCallback((refocus: boolean) => {
    clearTimer()
    setOpen(null)
    if (refocus) chipRef.current?.focus({ preventScroll: true })
  }, [])

  return (
    <span
      className={CHIP}
      onPointerEnter={e => hoverIn(e.pointerType)}
      onPointerLeave={e => hoverOut(e.pointerType)}
    >
      <button
        ref={chipRef}
        type="button"
        data-composer-comments={composerKey}
        aria-haspopup="dialog"
        aria-expanded={!!open}
        // A keyboard press (detail 0) opens the list with its first row focused.
        onClick={e => (open?.by === 'pin' ? close(false) : setOpen({ by: 'pin', focusFirst: e.detail === 0 }))}
        className={`${CHIP_BODY} hover:bg-secondary transition-colors ${onRemoveGroup ? 'pl-2 pr-1' : 'px-2'}`}
      >
        {kind === 'comments'
          ? <MessageSquare size={13} className="shrink-0 text-muted-foreground" aria-hidden />
          : <TextQuote size={13} className="shrink-0 text-muted-foreground" aria-hidden />}
        <span key={bump} className={`truncate ${bump > 0 ? 'animate-chip-bump' : ''}`}>{label}</span>
      </button>
      {onRemoveGroup && (
        <button
          type="button"
          onClick={() => {
            close(false)
            onRemoveGroup()
          }}
          aria-label={kind === 'comments' ? t('Remove all comments') : t('Remove all selections')}
          title={kind === 'comments' ? t('Remove all comments') : t('Remove all selections')}
          className={REMOVE}
        >
          <X size={12} aria-hidden />
        </button>
      )}
      {open && (
        <ReferencePopover
          anchor={chipRef}
          kind={kind}
          references={references}
          baseDir={baseDir}
          sheet={isMobile}
          focusFirst={open.focusFirst}
          onPointerEnter={hoverIn}
          onPointerLeave={hoverOut}
          onReveal={(ref) => {
            close(true)
            onReveal(ref)
          }}
          onRemoveOne={onRemoveOne}
          onClose={close}
        />
      )}
    </span>
  )
}

// ============================================
// The list a group chip opens
// ============================================

interface ReferencePopoverProps {
  anchor: React.RefObject<HTMLElement>
  kind: GroupKind
  references: readonly ContentReference[]
  baseDir?: string
  /** A sheet from the bottom of the screen (phones) instead of a panel above the chip. */
  sheet: boolean
  focusFirst: boolean
  onPointerEnter: (pointerType: string) => void
  onPointerLeave: (pointerType: string) => void
  onReveal: (ref: ContentReference) => void
  onRemoveOne?: (ref: ContentReference) => void
  onClose: (refocus: boolean) => void
}

const GAP = 6
const MARGIN = 8

function ReferencePopover({
  anchor, kind, references, baseDir, sheet, focusFirst, onPointerEnter, onPointerLeave, onReveal, onRemoveOne, onClose,
}: ReferencePopoverProps) {
  const { t } = useTranslation()
  const panelRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (sheet) return
    const chip = anchor.current?.getBoundingClientRect()
    const panel = panelRef.current?.getBoundingClientRect()
    if (!chip || !panel) return
    const above = chip.top - panel.height - GAP
    const top = above >= MARGIN ? above : Math.min(chip.bottom + GAP, window.innerHeight - panel.height - MARGIN)
    const left = Math.max(MARGIN, Math.min(chip.left, window.innerWidth - panel.width - MARGIN))
    setPosition({ top, left })
  }, [anchor, sheet, references.length])

  useEffect(() => {
    if (focusFirst) panelRef.current?.querySelector<HTMLElement>('[data-reference-row]')?.focus({ preventScroll: true })
  }, [focusFirst])

  // Emptied by removing its last row: nothing left to show.
  useEffect(() => {
    if (references.length === 0) onClose(true)
  }, [references.length, onClose])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (panelRef.current?.contains(target) || anchor.current?.parentElement?.contains(target)) return
      onClose(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [anchor, onClose])

  const rows = () => [...(panelRef.current?.querySelectorAll<HTMLElement>('[data-reference-row]') ?? [])]
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      // Esc closes the list only: not the canvas, not the composer.
      e.preventDefault()
      e.stopPropagation()
      onClose(true)
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const list = rows()
    if (list.length === 0) return
    e.preventDefault()
    const index = list.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'ArrowDown' ? Math.min(list.length - 1, index + 1) : Math.max(0, index - 1)
    list[index < 0 ? 0 : next].focus()
  }
  const removeByKeyboard = (ref: ContentReference, index: number) => {
    if (!onRemoveOne) return
    onRemoveOne(ref)
    requestAnimationFrame(() => {
      const list = rows()
      list[Math.min(index, list.length - 1)]?.focus()
    })
  }

  const title = kind === 'comments' ? t('Comments') : t('Selections')
  const panel = (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={title}
      onKeyDown={handleKeyDown}
      onPointerEnter={e => onPointerEnter(e.pointerType)}
      onPointerLeave={e => onPointerLeave(e.pointerType)}
      className={sheet
        ? 'fixed inset-x-0 bottom-0 z-50 max-h-[70vh] overflow-y-auto rounded-t-xl border-t border-border bg-popover p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-popover-foreground shadow-pop animate-composer-rise'
        : `fixed z-50 max-h-[320px] w-[min(92vw,360px)] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-pop scrollbar-thin ${position ? 'animate-pop-in' : 'opacity-0'}`}
      style={sheet ? undefined : (position ?? { top: 0, left: 0 })}
    >
      <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-subtle-foreground">{title}</div>
      <ul role="list" className="flex flex-col">
        {references.map((ref, index) => (
          <PopoverRow
            key={ref.id}
            reference={ref}
            baseDir={baseDir}
            sheet={sheet}
            onReveal={() => onReveal(ref)}
            onRemove={onRemoveOne ? () => onRemoveOne(ref) : undefined}
            onRemoveByKeyboard={() => removeByKeyboard(ref, index)}
          />
        ))}
      </ul>
    </div>
  )
  return createPortal(
    sheet ? (
      <>
        <div className="fixed inset-0 z-40 bg-black/30" onClick={() => onClose(false)} aria-hidden />
        {panel}
      </>
    ) : panel,
    document.body,
  )
}

function PopoverRow({ reference, baseDir, sheet, onReveal, onRemove, onRemoveByKeyboard }: {
  reference: ContentReference
  baseDir?: string
  sheet: boolean
  onReveal: () => void
  onRemove?: () => void
  onRemoveByKeyboard: () => void
}) {
  const { t } = useTranslation()
  const quote = reference.note ? '' : quoteFirstLine(reference)
  let detail: ReactNode = null
  if (reference.note) {
    detail = <span className="line-clamp-2 break-words text-[12.5px] leading-snug text-foreground [overflow-wrap:anywhere]">{reference.note}</span>
  } else if (quote) {
    detail = <span className="truncate font-mono text-[11.5px] text-subtle-foreground">{quote}</span>
  }
  return (
    <li className="group/row relative">
      <button
        type="button"
        data-reference-row=""
        title={referenceTooltip(reference, t, baseDir)}
        onClick={onReveal}
        onKeyDown={e => {
          if ((e.key === 'Delete' || e.key === 'Backspace') && onRemove) {
            e.preventDefault()
            onRemoveByKeyboard()
          }
        }}
        className={`flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2 text-left hover:bg-secondary focus-visible:bg-secondary
          focus-visible:outline-none ${sheet ? 'min-h-[44px] py-2' : 'py-1.5'} ${onRemove ? 'pr-8' : ''}`}
      >
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-[11.5px] text-muted-foreground">
          <ReferenceKindIcon reference={reference} size={12} />
          <span className="truncate">{referenceLabel(reference, t)}</span>
        </span>
        {detail}
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={reference.note ? t('Remove comment') : t('Remove selection')}
          className={`absolute right-1.5 top-1.5 flex h-[22px] w-[22px] items-center justify-center rounded-md text-muted-foreground
            hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50
            ${sheet ? '' : 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100'}`}
        >
          <X size={12} aria-hidden />
        </button>
      )}
    </li>
  )
}
