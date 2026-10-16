/**
 * The commit graph sub-page: a lane per branch line, one row per commit, drawn
 * as SVG curves from the lane layout. Rows load in pages as the view nears the
 * bottom; clicking a row compares that commit with its first parent on the
 * changes page. Read-only browsing — no checkout, no reset. While hidden it
 * runs no git at all.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent, type UIEvent } from 'react'
import { ChevronDown, GitBranch, Loader2, Search, User } from 'lucide-react'
import type { GitGraphQuery, GitRevisionOption } from '../../../../../../shared/types/git'
import { useTranslation } from '../../../../../i18n'
import { failureOf, gitClient } from '../state/git-client'
import { useViewerResources } from '../../../viewer-resources'
import { gitErrorMessage } from '../state/git-errors'
import { LoadErrorState, LoadingState } from '../shared/EmptyStates'
import { Menu, MenuItem, MenuLabel, MenuNote } from '../shared/Menu'
import { formatTime } from '../shared/format'
import { EMPTY_VIEW, GraphLoader, settleLoad, type GraphView } from './graph-pages'
import { layoutGraph, type GraphRowLayout, type LaneState, type GraphSourceCommit } from './lanes'

const ROW_H = 30
/** Center of the first lane; a lane every this many pixels after it. */
const LANE_STEP = 14
const GRAPH_PAD = 12
const OVERSCAN = 8
/** Rows below the last shown one at which the next page is asked for. */
const PREFETCH_ROWS = 30

/** Lane colors, cycling; the first lane stays blue across themes. */
const LANE_COLORS = ['#3b82f6', '#f97316', '#10b981', '#a855f7', '#ef4444', '#06b6d4', '#d9a53c', '#ec4899']

const laneColor = (lane: number): string => LANE_COLORS[lane % LANE_COLORS.length]
const laneX = (lane: number): number => GRAPH_PAD + lane * LANE_STEP

interface GitGraphPageProps {
  spaceId: string
  repoRoot: string
  /** False while another sub-page is shown: the page stays mounted, its data kept, and loads nothing. */
  active: boolean
  /** The commit the changes page is comparing, if any. */
  selected: string | null
  onCompare: (oid: string, subject: string) => void
}

export function GitGraphPage({ spaceId, repoRoot, active, selected, onCompare }: GitGraphPageProps) {
  const { t, i18n } = useTranslation()
  const resources = useViewerResources()
  const [branch, setBranch] = useState<string | null>(null)
  const [authorDraft, setAuthorDraft] = useState('')
  const [author, setAuthor] = useState('')
  const [messageDraft, setMessageDraft] = useState('')
  const [message, setMessage] = useState('')
  const [view, setView] = useState<GraphView>(EMPTY_VIEW)
  const [loading, setLoading] = useState(true)
  const [appending, setAppending] = useState(false)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const { pages, failure } = view
  const commits = pages.commits

  const query = useMemo<GitGraphQuery>(
    () => ({ branch: branch ?? undefined, author: author || undefined, message: message || undefined }),
    [branch, author, message]
  )
  // A load reads the query and the list as they are when it starts, not when it was asked for.
  const latest = useRef({ spaceId, repoRoot, query, read: pages.read })
  latest.current = { spaceId, repoRoot, query, read: pages.read }
  // Counts settled loads, even those that leave the view as it was.
  const [settled, countSettled] = useReducer((n: number) => n + 1, 0)
  const [loader] = useState(() => new GraphLoader(
    (mode) => {
      const current = latest.current
      return gitClient.getCommitGraph(current.spaceId, current.repoRoot, { ...current.query, skip: mode === 'append' ? current.read : 0 })
    },
    (mode, outcome) => {
      if (mode === 'reset') setLoading(false)
      if (mode === 'append') setAppending(false)
      // The one failure the view does not show: the rows on screen stay.
      if (mode === 'refresh' && 'error' in outcome) console.warn('[ChangesView] Graph refresh failed:', failureOf(outcome.error))
      setView((current) => settleLoad(current, mode, outcome))
      countSettled()
    }
  ))
  useEffect(() => () => loader.dispose(), [loader])

  const startOver = useCallback(() => {
    setView(EMPTY_VIEW)
    setAppending(false)
    setLoading(true)
    setScrollTop(0)
    if (containerRef.current) containerRef.current.scrollTop = 0
    loader.load('reset')
  }, [loader])

  // The first page loads when the graph is first shown and again each time it is
  // shown, so new commits appear; a new query starts over. Hidden, it loads nothing.
  const listQuery = useRef<GitGraphQuery | null>(null)
  useEffect(() => {
    if (!active) return
    if (listQuery.current === query) {
      loader.load('refresh')
      return
    }
    listQuery.current = query
    startOver()
  }, [active, query, loader, startOver])

  // Filters apply on Enter, not while typing; Escape puts the drafts back to what is applied.
  const applyFilters = useCallback(() => {
    setAuthor(authorDraft.trim())
    setMessage(messageDraft.trim())
  }, [authorDraft, messageDraft])
  const onFilterKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      applyFilters()
    } else if (e.key === 'Escape') {
      setAuthorDraft(author)
      setMessageDraft(message)
    }
  }, [applyFilters, author, message])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const scope = resources.scope()
    const observer = scope.add(new ResizeObserver(() => setViewport(el.clientHeight)))
    observer.observe(el)
    setViewport(el.clientHeight)
    return () => scope.dispose()
  }, [resources])

  const onScroll = useCallback((e: UIEvent<HTMLDivElement>) => setScrollTop(e.currentTarget.scrollTop), [])

  // The rows in view come near the end of the list: the next page. Asked for when
  // that first holds and after each settled load while it still does, never per
  // scroll event: while another load runs, it waits for that one to settle.
  // After a failure, only the user's retry asks again.
  const nearEnd = active && !loading && !failure && pages.more
    && scrollTop + viewport > (commits.length - PREFETCH_ROWS) * ROW_H
  useEffect(() => {
    if (!nearEnd || loader.busy) return
    setAppending(true)
    loader.load('append')
  }, [nearEnd, settled, loader])

  // The layout extends page by page: appending a page lays out only the new rows,
  // so a deep scroll never recomputes — or blocks — on everything above it.
  // A filtered list draws edges only between loaded commits: parents the filter
  // drops never load, so edges to them would hold a lane each and grow without bound.
  const layoutBase = useRef<{ source: readonly GraphSourceCommit[]; count: number; parents: 'all' | 'loaded'; state: LaneState; rows: GraphRowLayout[] } | null>(null)
  const layout = useMemo(() => {
    const parents: 'all' | 'loaded' = author || message ? 'loaded' : 'all'
    const base = layoutBase.current
    let previous: Parameters<typeof layoutGraph>[1] | undefined
    if (base && base.parents === parents && base.count <= commits.length) {
      let same = true
      for (let i = 0; i < base.count; i++) {
        if (base.source[i] !== commits[i]) { same = false; break }
      }
      if (same) previous = { count: base.count, state: base.state, rows: base.rows }
    }
    const result = layoutGraph(commits, previous, { parents })
    layoutBase.current = { source: commits, count: commits.length, parents, state: result.state, rows: result.rows }
    return result
  }, [commits, author, message])
  const graphWidth = GRAPH_PAD * 2 + (layout.laneCount - 1) * LANE_STEP
  // Only the rows in view are rendered; the rest is empty scroll space.
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const shown = commits.slice(first, Math.max(0, Math.ceil((scrollTop + viewport) / ROW_H) + OVERSCAN))
  const now = Date.now()

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2">
        <BranchPicker spaceId={spaceId} repoRoot={repoRoot} branch={branch} onBranch={setBranch} />
        <label className="flex h-7 w-[96px] min-w-[72px] items-center gap-1.5 rounded-md border border-border bg-background px-2 focus-within:border-primary sm:w-[140px] sm:min-w-[90px]">
          <User size={13} className="shrink-0 text-faint-foreground" aria-hidden />
          <input
            value={authorDraft}
            onChange={(e) => setAuthorDraft(e.target.value)}
            onKeyDown={onFilterKeyDown}
            placeholder={t('Author…')}
            aria-label={t('Filter by author (Enter)')}
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-subtle-foreground"
          />
        </label>
        <label className="flex h-7 min-w-0 max-w-[260px] flex-1 items-center gap-1.5 rounded-md border border-border bg-background px-2 focus-within:border-primary">
          <Search size={13} className="shrink-0 text-faint-foreground" aria-hidden />
          <input
            value={messageDraft}
            onChange={(e) => setMessageDraft(e.target.value)}
            onKeyDown={onFilterKeyDown}
            placeholder={t('Search commit messages…')}
            aria-label={t('Search commit messages (Enter)')}
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-subtle-foreground"
          />
        </label>
        <span className="ml-auto hidden shrink-0 text-[12px] text-subtle-foreground sm:inline">
          {loading ? t('Loading…') : t('{{count}} commits', { count: commits.length })}
        </span>
      </div>
      <div ref={containerRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <LoadingState />
        ) : failure?.mode === 'reset' ? (
          <LoadErrorState message={gitErrorMessage(failureOf(failure.error), t)} onRetry={startOver} />
        ) : commits.length === 0 ? (
          <div className="flex h-full min-h-[240px] items-center justify-center p-6 text-sm text-subtle-foreground">
            {author || message || branch ? t('No commits match') : t('No commits yet')}
          </div>
        ) : (
          <div className="relative" style={{ height: commits.length * ROW_H }}>
            {shown.map((commit, offset) => {
              const index = first + offset
              const row = layout.rows[index]
              const isSelected = commit.oid === selected
              return (
                <button
                  key={commit.oid}
                  type="button"
                  aria-current={isSelected || undefined}
                  onClick={() => onCompare(commit.oid, commit.subject)}
                  style={{ top: index * ROW_H, height: ROW_H }}
                  className={`absolute inset-x-0 flex cursor-pointer select-none items-center gap-2 pr-3 text-left text-[12.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 ${
                    isSelected ? 'bg-primary/10' : 'hover:bg-surface-hover'
                  }`}
                >
                  <svg width={graphWidth} height={ROW_H} className="shrink-0" aria-hidden>
                    {row.through.map((lane) => (
                      <line key={`t${lane}`} x1={laneX(lane)} x2={laneX(lane)} y1={0} y2={ROW_H} stroke={laneColor(lane)} strokeWidth={1.5} />
                    ))}
                    {row.incoming.map((lane) => (
                      <path key={`i${lane}`} d={`M ${laneX(lane)} 0 Q ${laneX(lane)} ${ROW_H / 2} ${laneX(row.lane)} ${ROW_H / 2}`} fill="none" stroke={laneColor(lane)} strokeWidth={1.5} />
                    ))}
                    {row.outgoing.map((lane) => (
                      <path key={`o${lane}`} d={`M ${laneX(row.lane)} ${ROW_H / 2} Q ${laneX(lane)} ${ROW_H / 2} ${laneX(lane)} ${ROW_H}`} fill="none" stroke={laneColor(lane)} strokeWidth={1.5} />
                    ))}
                    <circle cx={laneX(row.lane)} cy={ROW_H / 2} r={3.5} fill={laneColor(row.lane)} />
                  </svg>
                  {commit.refs.length > 0 && (
                    // Narrow rows show one ref, and refs that would push the row past its width shrink.
                    <span className="flex min-w-0 items-center gap-1">
                      {commit.refs.slice(0, 3).map((ref, i) => (
                        // A ref carries the color of the lane its commit sits in.
                        <span
                          key={ref}
                          className={`max-w-[96px] truncate rounded border px-1 font-mono text-[11px] sm:max-w-[140px] ${i > 0 ? 'hidden sm:inline' : ''}`}
                          style={{ color: laneColor(row.lane), borderColor: `${laneColor(row.lane)}59`, backgroundColor: `${laneColor(row.lane)}14` }}
                          title={ref}
                        >
                          {ref}
                        </span>
                      ))}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-foreground" title={commit.subject}>{commit.subject}</span>
                  <span className="hidden shrink-0 text-subtle-foreground sm:inline">{commit.author}</span>
                  <span className="shrink-0 text-subtle-foreground">{formatTime(Date.parse(commit.date), i18n.language, now)}</span>
                  <span className="hidden shrink-0 font-mono text-[11.5px] text-faint-foreground sm:inline">{commit.shortOid}</span>
                </button>
              )
            })}
            {appending ? (
              <div className="absolute inset-x-0 flex items-center justify-center gap-2 py-2 text-[12px] text-subtle-foreground" style={{ top: commits.length * ROW_H }}>
                <Loader2 size={13} className="animate-spin" aria-hidden />{t('Loading more…')}
              </div>
            ) : failure && (
              <div className="absolute inset-x-0 flex items-center justify-center gap-2 px-3 py-2 text-[12px] text-subtle-foreground" style={{ top: commits.length * ROW_H }}>
                <span className="min-w-0 truncate">{gitErrorMessage(failureOf(failure.error), t)}</span>
                <button type="button" onClick={() => setView((current) => ({ ...current, failure: null }))} className="shrink-0 text-primary hover:underline">
                  {t('Try again')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function BranchPicker({ spaceId, repoRoot, branch, onBranch }: {
  spaceId: string
  repoRoot: string
  branch: string | null
  onBranch: (branch: string | null) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<GitRevisionOption[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const anchorRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open || options || error) return
    let cancelled = false
    gitClient.listRevisionOptions(spaceId, repoRoot).then(
      (found) => { if (!cancelled) setOptions(found) },
      (e: unknown) => { if (!cancelled) setError(gitErrorMessage(failureOf(e), t)) }
    )
    return () => {
      cancelled = true
    }
  }, [open, options, error, spaceId, repoRoot, t])

  const branches = (options ?? []).filter((o) => o.kind === 'branch')
  const remotes = (options ?? []).filter((o) => o.kind === 'remote-branch')

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex h-7 min-w-0 max-w-[140px] shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 sm:max-w-[200px]"
      >
        <GitBranch size={14} className="shrink-0 text-faint-foreground" aria-hidden />
        <span className="truncate">{branch ?? t('All branches')}</span>
        <ChevronDown size={12} className="shrink-0" aria-hidden />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} label={t('Branches')}>
        <MenuItem checked={!branch} onSelect={() => { setOpen(false); onBranch(null) }}>
          {t('All branches')}
        </MenuItem>
        {error && <MenuNote>{error}</MenuNote>}
        {!options && !error && (
          <div className="flex items-center gap-2 px-2 py-2 text-[12px] text-subtle-foreground">
            <Loader2 size={13} className="animate-spin" aria-hidden />{t('Loading…')}
          </div>
        )}
        {branches.length > 0 && <MenuLabel>{t('Branches')}</MenuLabel>}
        {branches.map((item) => (
          <MenuItem key={item.revision} checked={branch === item.revision} onSelect={() => { setOpen(false); onBranch(item.revision) }}>
            {item.revision}
          </MenuItem>
        ))}
        {remotes.length > 0 && <MenuLabel>{t('Remote branches')}</MenuLabel>}
        {remotes.map((item) => (
          <MenuItem key={item.revision} checked={branch === item.revision} onSelect={() => { setOpen(false); onBranch(item.revision) }}>
            {item.revision}
          </MenuItem>
        ))}
      </Menu>
    </>
  )
}
