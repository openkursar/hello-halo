/**
 * One file in the diff stack: a sticky header, then the diff once the card
 * is near the viewport and holds one of the stack's editor slots. Without a
 * slot it keeps the height it last measured, so the stack does not jump.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import type { Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { useTranslation } from '../../../../../i18n'
import { useViewerResources } from '../../../viewer-resources'
import { createDiffEditor, type DiffEditorHandle, type DiffLayout, type DiffSide } from './diff-editor'
import { estimateBodyHeight, type DiffPart, type LoadedDiff } from './diff-content'
import { useStackContext } from './stack-context'
import { DiffStat, FileGlyph, IconButton, PathTail, StateLetter } from '../shared/parts'
import { baseName, dirName } from '../model/paths'
import { formatBytes, formatCount } from '../shared/format'
import { isAbortError } from '../state/request-queue'
import type { ViewFile } from '../model/view-files'

export type CardGate = 'generated' | 'large' | null

/** At most this many frames a new editor's body is held at its old height (see FileDiffCard). */
const HOLD_MAX_FRAMES = 12
/** A note in place of the diff (generated, large, binary): its minimum height. */
const NOTE_HEIGHT = 44
/** The card's sticky header at its tallest (`h-10` on touch screens): it covers the top of the stack while its card scrolls under it. */
export const CARD_HEADER_HEIGHT = 40
/** A card's header and frame around its body, with the space around the card in the stack. */
const CARD_CHROME = 51

/** A card's height before it is measured: the stack lays out cards it has not shown by it. */
export function estimateCardHeight(file: ViewFile, folded: boolean, gate: CardGate, collapseUnchanged: boolean): number {
  if (folded) return CARD_CHROME - 1
  if (gate || file.binary) return CARD_CHROME + NOTE_HEIGHT
  return CARD_CHROME + estimateBodyHeight(file, collapseUnchanged)
}

interface FileDiffCardProps {
  file: ViewFile
  folded: boolean
  onToggleFold: (key: string) => void
  /** Why the diff waits for a click; null to show it. */
  gate: CardGate
  onLoad: (key: string) => void
  /** Reads the diff; `signal` aborts when the card no longer wants it (scrolled away). */
  load: (file: ViewFile, signal: AbortSignal) => Promise<LoadedDiff>
  /** Changes when the contents may have changed; the card reads its diff again. */
  version: number
  layout: DiffLayout
  collapseUnchanged: boolean
  /** Buttons for the header; a stable function, so cards re-render only when what it shows changes. */
  actionsFor?: (file: ViewFile) => ReactNode
  sideExtensions?: (file: ViewFile, part: DiffPart, side: DiffSide, unified: boolean) => Extension[]
}

type BodyState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; version: number; diff: LoadedDiff }
  | { status: 'error'; message: string }

function sameDiff(a: LoadedDiff, b: LoadedDiff): boolean {
  if (a.kind !== 'text' || b.kind !== 'text') return a.kind === b.kind && JSON.stringify(a) === JSON.stringify(b)
  return a.parts.length === b.parts.length &&
    a.parts.every((part, i) => part.before === b.parts[i].before && part.after === b.parts[i].after && part.kind === b.parts[i].kind)
}

export const FileDiffCard = memo(function FileDiffCard({
  file,
  folded,
  onToggleFold,
  gate,
  onLoad,
  load,
  version,
  layout,
  collapseUnchanged,
  actionsFor,
  sideExtensions,
}: FileDiffCardProps) {
  const { t, i18n } = useTranslation()
  const stack = useStackContext()
  const cardRef = useRef<HTMLElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [hasSlot, setHasSlot] = useState(false)
  const [body, setBody] = useState<BodyState>({ status: 'idle' })
  const [attempt, setAttempt] = useState(0)
  const wantsEditor = !folded && !gate && !file.binary
  // A binary file is read for its sizes once it is actually on screen; it never needs an editor.
  const wantsSizes = !folded && !gate && file.binary
  const [seen, setSeen] = useState(false)
  const heightKey = `${file.key}|${layout}|${collapseUnchanged ? 1 : 0}`

  useEffect(() => {
    const element = cardRef.current
    if (!wantsSizes || seen || !element) return
    return stack.observe(element, (visible) => {
      if (visible) setSeen(true)
    })
  }, [wantsSizes, seen, stack])

  // A slot while near the viewport; given up to other cards past the cap.
  useEffect(() => {
    const element = cardRef.current
    if (!wantsEditor || !element) return
    const acquire = (visible: boolean) => {
      if (stack.slots.has(file.key)) {
        stack.slots.setVisible(file.key, visible)
        return
      }
      if (!visible) return
      stack.slots.acquire(file.key, () => setHasSlot(false), true)
      setHasSlot(true)
    }
    stack.slots.acquire(file.key, () => setHasSlot(false))
    setHasSlot(true)
    const stopObserving = stack.observe(element, acquire)
    return () => {
      stopObserving()
      stack.slots.release(file.key)
      setHasSlot(false)
    }
  }, [wantsEditor, file.key, stack])

  // Read the diff when there is a slot for it, and again when the contents may have changed.
  const fileRef = useRef(file)
  fileRef.current = file
  const reads = (wantsSizes && seen) || (wantsEditor && hasSlot)
  useEffect(() => {
    if (!reads) return
    if (body.status === 'ready' && body.version === version) return
    const reading = new AbortController()
    if (body.status !== 'ready') setBody({ status: 'loading' })
    load(fileRef.current, reading.signal).then(
      (diff) => {
        if (reading.signal.aborted) return
        setBody((current) => (current.status === 'ready' && sameDiff(current.diff, diff)
          ? { ...current, version }
          : { status: 'ready', version, diff }))
      },
      (error: unknown) => {
        if (reading.signal.aborted || isAbortError(error)) return
        console.warn('[ChangesView] Could not load a diff:', fileRef.current.path, error)
        setBody({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    )
    return () => reading.abort()
    // `body` is read for the version check only; re-running on its own updates would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reads, version, file.key, load, attempt])

  // Settled without an editor: tell the stack, so navigation waiting for this card moves on.
  const showsEditors = wantsEditor && hasSlot && body.status === 'ready' && body.diff.kind === 'text'
  useEffect(() => {
    if (!wantsEditor) return
    if (body.status === 'error' || (body.status === 'ready' && body.diff.kind !== 'text')) stack.registerEditors(file.key, null)
  }, [wantsEditor, body, file.key, stack])

  // Remember the measured height for when the editor is gone.
  useEffect(() => {
    const element = bodyRef.current
    if (!showsEditors || !element) return
    return stack.measure(element, heightKey)
  }, [showsEditors, heightKey, stack])

  const placeholderHeight = stack.heights.get(heightKey) ?? estimateBodyHeight(file, collapseUnchanged)

  // A new editor sizes the lines it has not drawn by a guess, corrected a frame or two later
  // (by thousands of pixels for long wrapped lines). Meanwhile the body keeps the height it had,
  // so the cards below — and a jump aimed at this one — do not move with the guess.
  const placeholderHeightRef = useRef(placeholderHeight)
  placeholderHeightRef.current = placeholderHeight
  const held = useRef(false)
  const releaseHold = useCallback(() => {
    const element = bodyRef.current
    held.current = false
    if (!element) return
    element.style.height = ''
    element.style.overflow = ''
  }, [])
  useLayoutEffect(() => {
    const element = bodyRef.current
    if (!showsEditors || !element) return
    element.style.height = `${placeholderHeightRef.current}px`
    element.style.overflow = 'clip'
    held.current = true
    return releaseHold
  }, [showsEditors, releaseHold])
  const onEditorsReady = useCallback((handles: readonly DiffEditorHandle[]) => {
    if (!held.current) return
    const views = [...new Set(handles.flatMap((handle) => [handle.nav, handle.editorFor('before'), handle.editorFor('after')]))]
      .filter((view): view is EditorView => view !== null)
    let last = -1
    let frames = 0
    const check = () => {
      if (!held.current) return
      const height = views.reduce((sum, view) => sum + view.contentHeight, 0)
      if (height === last || ++frames >= HOLD_MAX_FRAMES) return releaseHold()
      last = height
      requestAnimationFrame(check)
    }
    requestAnimationFrame(check)
  }, [releaseHold])
  const dir = dirName(file.path)
  const oldName = file.oldPath ? baseName(file.oldPath) : null
  const lines = (file.additions ?? 0) + (file.deletions ?? 0)

  let content: ReactNode
  if (folded) {
    content = null
  } else if (file.binary) {
    // Sizes once they are read; the plain note meanwhile, or if they cannot be read.
    content = body.status === 'ready' && body.diff.kind !== 'text'
      ? <LoadedBody file={file} diff={body.diff} layout={layout} collapseUnchanged={collapseUnchanged} sideExtensions={sideExtensions} onEditorsReady={onEditorsReady} />
      : <Note>{t('Binary file')}</Note>
  } else if (gate) {
    content = (
      <Note>
        <span>
          {gate === 'generated' ? t('Generated file') : t('Large diff · {{lines}} lines', { count: lines, lines: formatCount(lines, i18n.language) })}
        </span>
        <button
          type="button"
          onClick={() => onLoad(file.key)}
          className="h-7 rounded-md border border-border bg-secondary px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {t('Load diff')}
        </button>
      </Note>
    )
  } else if (!hasSlot || body.status === 'idle' || body.status === 'loading') {
    content = (
      <div style={{ height: placeholderHeight }} className="diff-skeleton flex items-start justify-center pt-6" aria-busy={body.status === 'loading'}>
        {body.status === 'loading' && <Loader2 size={16} className="animate-spin text-subtle-foreground" aria-label={t('Loading…')} />}
      </div>
    )
  } else if (body.status === 'error') {
    content = (
      <Note>
        <span>{t('Couldn\'t load this file')}</span>
        <button
          type="button"
          onClick={() => {
            setBody({ status: 'idle' })
            setAttempt((n) => n + 1)
          }}
          className="h-7 rounded-md border border-border bg-secondary px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-hover"
        >
          {t('Retry')}
        </button>
      </Note>
    )
  } else {
    content = <LoadedBody file={file} diff={body.diff} layout={layout} collapseUnchanged={collapseUnchanged} sideExtensions={sideExtensions} onEditorsReady={onEditorsReady} />
  }

  return (
    <section
      ref={cardRef}
      data-file-key={file.key}
      className="overflow-clip rounded-lg border border-border bg-background"
    >
      <header className={`sticky top-0 z-[5] flex h-10 items-center gap-2 bg-card px-2 sm:h-9 ${folded ? '' : 'border-b border-border'}`}>
        <IconButton
          size="sm"
          label={folded ? t('Expand file') : t('Collapse file')}
          aria-expanded={!folded}
          onClick={() => onToggleFold(file.key)}
        >
          {folded ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </IconButton>
        <FileGlyph path={file.path} />
        {/* The folder (keeping its last segments) and a renamed file's old name give way before the name itself. A heading, so screen readers can jump file to file. */}
        <span
          role="heading"
          aria-level={3}
          className="flex min-w-0 items-baseline font-mono text-[12.5px]"
          title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        >
          {dir && <PathTail path={`${dir}/`} className="shrink-[10000] text-subtle-foreground" />}
          {oldName && (
            <>
              <span className="min-w-0 shrink-[10000] truncate text-subtle-foreground">{oldName}</span>
              <span className="min-w-0 overflow-hidden whitespace-pre text-subtle-foreground"> → </span>
            </>
          )}
          {/* Never shrinks while anything before it can; only capped by the heading itself. */}
          <span className={`shrink-0 truncate font-semibold text-foreground ${oldName ? 'max-w-[calc(100%-3ch)]' : 'max-w-full'}`}>{baseName(file.path)}</span>
        </span>
        <StateLetter state={file.state} />
        <DiffStat additions={file.additions} deletions={file.deletions} binary={file.binary} className="hidden sm:inline" />
        <span className="flex-1" />
        {actionsFor?.(file)}
      </header>
      {!folded && <div ref={bodyRef}>{content}</div>}
    </section>
  )
})

function Note({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-[12.5px] text-subtle-foreground" style={{ minHeight: NOTE_HEIGHT }}>{children}</div>
}

function LoadedBody({ file, diff, layout, collapseUnchanged, sideExtensions, onEditorsReady }: {
  file: ViewFile
  diff: LoadedDiff
  layout: DiffLayout
  collapseUnchanged: boolean
  sideExtensions?: FileDiffCardProps['sideExtensions']
  onEditorsReady: (handles: readonly DiffEditorHandle[]) => void
}) {
  const { t, i18n } = useTranslation()
  const stack = useStackContext()
  const handles = useRef(new Map<number, DiffEditorHandle>())
  const parts = diff.kind === 'text' ? diff.parts : []

  const onReady = (index: number, handle: DiffEditorHandle | null) => {
    if (handle) handles.current.set(index, handle)
    else handles.current.delete(index)
    if (handles.current.size === parts.length) {
      const ready = [...handles.current.entries()].sort((a, b) => a[0] - b[0]).map(([, h]) => h)
      stack.registerEditors(file.key, ready)
      if (handle) onEditorsReady(ready)
    } else if (!handle) {
      stack.registerEditors(file.key, undefined)
    }
  }

  if (diff.kind === 'binary') {
    const { beforeBytes, afterBytes } = diff
    const text = beforeBytes !== undefined && afterBytes !== undefined
      ? t('Binary file · {{before}} → {{after}}', { before: formatBytes(beforeBytes, i18n.language), after: formatBytes(afterBytes, i18n.language) })
      : t('Binary file · {{size}}', { size: formatBytes(afterBytes ?? beforeBytes ?? 0, i18n.language) })
    return <Note>{text}</Note>
  }
  if (diff.kind === 'too-large') {
    const size = Math.max(diff.beforeBytes ?? 0, diff.afterBytes ?? 0)
    return <Note>{t('Too large to show ({{size}})', { size: formatBytes(size, i18n.language) })}</Note>
  }
  if (diff.kind === 'unchanged') return <Note>{t('No content changes')}</Note>

  return (
    <div>
      {parts.map((part, index) => (
        <div key={part.id} className={index > 0 ? 'border-t border-border' : ''}>
          {parts.length > 1 && (
            <div className="bg-card/60 px-3 py-1 text-[11.5px] text-subtle-foreground">
              {t('Edit {{n}} of {{total}}', { n: index + 1, total: parts.length })}
            </div>
          )}
          <DiffEditorHost
            file={file}
            part={part}
            layout={layout}
            collapseUnchanged={collapseUnchanged}
            sideExtensions={sideExtensions}
            onReady={(handle) => onReady(index, handle)}
          />
        </div>
      ))}
    </div>
  )
}

function DiffEditorHost({ file, part, layout, collapseUnchanged, sideExtensions, onReady }: {
  file: ViewFile
  part: DiffPart
  layout: DiffLayout
  collapseUnchanged: boolean
  sideExtensions?: FileDiffCardProps['sideExtensions']
  onReady: (handle: DiffEditorHandle | null) => void
}) {
  const { t } = useTranslation()
  const resources = useViewerResources()
  const { scrollParent } = useStackContext()
  const hostRef = useRef<HTMLDivElement>(null)
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  // A refreshed list brings new file objects; the editor only follows what it shows.
  const fileRef = useRef(file)
  fileRef.current = file
  // Keyed by the text, not by `t`: a new `t` with the same strings must not rebuild the editors.
  const unchangedLines = t('$ unchanged lines')
  const phrases = useMemo(() => ({ '$ unchanged lines': unchangedLines }), [unchangedLines])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const scope = resources.scope()
    const shown = fileRef.current
    const handle = scope.add(createDiffEditor(host, {
      before: part.before,
      after: part.after,
      kind: part.kind,
      layout,
      collapseUnchanged,
      path: shown.path,
      lineNumbers: part.lineNumbers,
      phrases,
      labels: {
        before: t('{{location}} · Before', { location: shown.oldPath ?? shown.path }),
        after: t('{{location}} · After', { location: shown.path }),
        both: shown.path,
      },
      sideExtensions: sideExtensions ? (side, unified) => sideExtensions(shown, part, side, unified) : undefined,
      scrollParent,
    }))
    onReadyRef.current(handle)
    return () => {
      onReadyRef.current(null)
      scope.dispose()
    }
  }, [file.key, part, layout, collapseUnchanged, phrases, sideExtensions, scrollParent, resources])

  return <div ref={hostRef} className="min-w-0" />
}
