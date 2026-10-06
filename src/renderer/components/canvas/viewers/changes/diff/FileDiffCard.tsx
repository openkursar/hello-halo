/** A mounted file keeps its read-only editors until it is folded or replaced. */

import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import type { Extension } from '@codemirror/state'
import { useTranslation } from '../../../../../i18n'
import { useViewerResources } from '../../../viewer-resources'
import { createDiffEditor, type DiffEditorHandle, type DiffLayout, type DiffSide } from './diff-editor'
import type { DiffPart, LoadedDiff } from './diff-content'
import { useStackContext } from './stack-context'
import { MAX_STACK_PARTS } from './stack-policy'
import { DiffStat, FileGlyph, IconButton, PathTail, StateLetter } from '../shared/parts'
import { baseName, dirName } from '../model/paths'
import { formatBytes, formatCount } from '../shared/format'
import { isAbortError } from '../state/request-queue'
import type { ViewFile } from '../model/view-files'

export type CardGate = 'generated' | 'large' | null

const NOTE_HEIGHT = 44
/** The sticky header covers the top of the stack on touch screens. */
export const CARD_HEADER_HEIGHT = 40

interface FileDiffCardProps {
  file: ViewFile
  folded: boolean
  onToggleFold: (key: string) => void
  /** Why the diff waits for a click; null to show it. */
  gate: CardGate
  onLoad: (key: string) => void
  /** Reads the diff; selection changes and folding cancel work no longer needed. */
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
  const [body, setBody] = useState<BodyState>({ status: 'idle' })
  const [attempt, setAttempt] = useState(0)
  const fileRef = useRef(file)
  fileRef.current = file
  const reads = !folded && !gate
  useEffect(() => {
    if (!reads) return
    if (body.status === 'ready' && body.version === version) return
    const reading = new AbortController()
    if (body.status !== 'ready') setBody({ status: 'loading' })
    load(fileRef.current, reading.signal).then(
      (diff) => {
        if (reading.signal.aborted || !stack.admitContent(fileRef.current.key, diff)) return
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

  useEffect(() => {
    if (body.status !== 'error' && !(body.status === 'ready' && body.diff.kind !== 'text')) return
    stack.registerEditors(file.key, null)
    return () => stack.registerEditors(file.key, undefined)
  }, [body, file.key, stack])
  const dir = dirName(file.path)
  const oldName = file.oldPath ? baseName(file.oldPath) : null
  const lines = (file.additions ?? 0) + (file.deletions ?? 0)

  let content: ReactNode
  if (folded) {
    content = null
  } else if (file.binary) {
    // Sizes once they are read; the plain note meanwhile, or if they cannot be read.
    content = body.status === 'ready' && body.diff.kind !== 'text'
      ? <LoadedBody file={file} diff={body.diff} layout={layout} collapseUnchanged={collapseUnchanged} sideExtensions={sideExtensions} />
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
  } else if (body.status === 'idle' || body.status === 'loading') {
    content = (
      <div className="flex h-16 items-center justify-center gap-2 text-xs text-muted-foreground" aria-busy="true">
        <Loader2 size={15} className="animate-spin" aria-hidden />
        {t('Loading…')}
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
    content = <LoadedBody file={file} diff={body.diff} layout={layout} collapseUnchanged={collapseUnchanged} sideExtensions={sideExtensions} />
  }

  return (
    <section
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
      {!folded && <div>{content}</div>}
    </section>
  )
})

function Note({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-[12.5px] text-subtle-foreground" style={{ minHeight: NOTE_HEIGHT }}>{children}</div>
}

function LoadedBody({ file, diff, layout, collapseUnchanged, sideExtensions }: {
  file: ViewFile
  diff: LoadedDiff
  layout: DiffLayout
  collapseUnchanged: boolean
  sideExtensions?: FileDiffCardProps['sideExtensions']
}) {
  const { t, i18n } = useTranslation()
  const stack = useStackContext()
  const handles = useRef(new Map<number, DiffEditorHandle>())
  const [partPage, setPartPage] = useState(() => stack.partPage(file.key))
  const parts = diff.kind === 'text' ? diff.parts : []
  const paged = parts.length > MAX_STACK_PARTS
  const pageCount = Math.max(1, Math.ceil(parts.length / MAX_STACK_PARTS))
  const page = Math.min(partPage, pageCount - 1)
  const visibleParts = paged ? parts.slice(page * MAX_STACK_PARTS, (page + 1) * MAX_STACK_PARTS) : parts

  const setPage = (next: number) => {
    if (next === page) return false
    stack.registerEditors(file.key, undefined)
    stack.onPartPageChange(file.key, next)
    setPartPage(next)
    return true
  }
  const navigatePage = (direction: 1 | -1, fromEdge: boolean) => {
    const next = fromEdge ? (direction > 0 ? 0 : pageCount - 1) : page + direction
    return next >= 0 && next < pageCount && setPage(next)
  }

  const onReady = (index: number, handle: DiffEditorHandle | null) => {
    if (handle) handles.current.set(index, handle)
    else handles.current.delete(index)
    if (handles.current.size === visibleParts.length) {
      stack.registerEditors(file.key, [...handles.current.entries()].sort((a, b) => a[0] - b[0]).map(([, h]) => h), paged ? navigatePage : undefined)
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
      {paged && (
        <Note>
          <span className="flex-1">{t('Edits {{from}}–{{to}} of {{total}}', { from: page * MAX_STACK_PARTS + 1, to: Math.min((page + 1) * MAX_STACK_PARTS, parts.length), total: parts.length })}</span>
          <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)} className="rounded border border-border px-2 py-1 hover:bg-secondary disabled:opacity-40">{t('Previous edits')}</button>
          <button type="button" disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)} className="rounded border border-border px-2 py-1 hover:bg-secondary disabled:opacity-40">{t('Next edits')}</button>
        </Note>
      )}
      {visibleParts.map((part, index) => (
        <div key={part.id} className={index > 0 ? 'border-t border-border' : ''}>
          {parts.length > 1 && (
            <div className="bg-card/60 px-3 py-1 text-[11.5px] text-subtle-foreground">
              {t('Edit {{n}} of {{total}}', { n: page * MAX_STACK_PARTS + index + 1, total: parts.length })}
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
