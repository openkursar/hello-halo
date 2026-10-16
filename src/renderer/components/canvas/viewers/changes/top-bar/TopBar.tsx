/**
 * Top bar of a Git changes tab: repository, compare scope, totals, the
 * sub-pages, the diff controls and the file list toggle. Wraps onto two rows
 * on a narrow canvas.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { BookMarked, ChevronDown, Clock3, GitBranch, Loader2, Search } from 'lucide-react'
import type { GitRepository, GitReviewRecord, GitRevisionOption } from '../../../../../../shared/types/git'
import { useTranslation } from '../../../../../i18n'
import { failureOf, gitClient } from '../state/git-client'
import { gitErrorMessage } from '../state/git-errors'
import { Menu, MenuItem, MenuLabel, MenuNote, MenuSeparator } from '../shared/Menu'
import { DiffStat } from '../shared/parts'
import { revisionName, sameStoredScope, scopeLabel, scopeShortLabel } from '../model/scope'
import { formatTime } from '../shared/format'
import type { ChangeTotals } from '../model/view-files'
import type { ChangesPage, StoredCompareScope } from '../../../../../types/changes-view'
import type { ChangesLayout } from '../shared/use-container-width'

const TRIGGER = 'inline-flex min-w-0 items-center gap-1.5 rounded-sm px-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60'

/** Phones get finger-sized targets: the stacked top bar's first row is 40px tall. */
function triggerHeight(layout: ChangesLayout): string {
  return layout.stacked ? 'h-10' : 'h-7'
}

interface TopBarProps {
  spaceId: string
  repositories: GitRepository[]
  repo: GitRepository | null
  onSelectRepository: (root: string) => void
  scope: StoredCompareScope
  review: GitReviewRecord | null
  /** "Since last review" cannot load: its snapshot is gone. */
  snapshotMissing: boolean
  onScope: (scope: StoredCompareScope) => void
  totals: ChangeTotals | null
  page: ChangesPage
  onPage: (page: ChangesPage) => void
  /** Diff controls, shown while diffs are on screen (the changes page or a detail page). */
  tools: ReactNode | null
  panelToggle: ReactNode
  layout: ChangesLayout
}

export function TopBar(props: TopBarProps) {
  const { t } = useTranslation()
  const { repo, totals, layout } = props
  // A narrower canvas keeps the controls and drops the totals (the overview and the file list still have them).
  const stats = totals && (
    <span className="flex shrink-0 items-center gap-2">
      <DiffStat additions={totals.additions} deletions={totals.deletions} />
      {!layout.hideMinorStats && (
        <span className="whitespace-nowrap text-[12px] text-subtle-foreground">
          {t('{{count}} files', { count: totals.files })}
        </span>
      )}
    </span>
  )
  const pickers = (
    <>
      {repo && <RepositoryPicker {...props} repo={repo} />}
      <ScopePicker {...props} />
    </>
  )

  if (layout.stacked) {
    return (
      <div className="shrink-0 border-b border-border">
        <div className="flex h-10 min-w-0 items-center gap-1 px-2">
          {pickers}
          <span className="flex-1" />
          {props.tools}
          {props.panelToggle}
        </div>
        <div className="px-2 pb-2 pt-1">
          <PageSwitch page={props.page} onPage={props.onPage} full showBadge />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
      {pickers}
      {stats}
      <span className="min-w-1 flex-1" />
      {/* On a narrower canvas the "AI" mark gives way first, so the totals keep their place. */}
      <PageSwitch page={props.page} onPage={props.onPage} showBadge={!layout.hideMinorStats} />
      <span className="min-w-1 flex-1" />
      {props.tools}
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      {props.panelToggle}
    </div>
  )
}

function RepositoryPicker({ repositories, repo, onSelectRepository, layout }: TopBarProps & { repo: GitRepository }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const branch = repo.branch ?? (repo.head ? t('Detached at {{commit}}', { commit: repo.head }) : t('No commits yet'))
  const label = (
    <>
      {/* Below the widest step the icons give their room to the names. */}
      {!layout.hideMinorStats && <BookMarked size={14} className="shrink-0 text-faint-foreground" aria-hidden />}
      <span className="truncate font-semibold text-foreground">{repo.name}</span>
      {!layout.hideMinorStats && <span className="hidden truncate text-[12px] text-subtle-foreground min-[460px]:inline">{branch}</span>}
    </>
  )

  if (repositories.length <= 1) {
    return <span className={`inline-flex ${triggerHeight(layout)} min-w-0 max-w-[220px] shrink items-center gap-1.5 px-1.5 text-[13px]`} title={repo.root}>{label}</span>
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={repo.root}
        className={`${TRIGGER} ${triggerHeight(layout)} max-w-[220px] shrink-[0.3]`}
      >
        {label}
        <ChevronDown size={12} className="shrink-0" aria-hidden />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} label={t('Repositories in this space')}>
        <MenuLabel>{t('Repositories in this space')}</MenuLabel>
        {repositories.map((item) => (
          <MenuItem
            key={item.root}
            checked={item.root === repo.root}
            description={[item.branch ?? item.head ?? t('No commits yet'), item.relativePath].filter(Boolean).join(' · ')}
            onSelect={() => {
              setOpen(false)
              onSelectRepository(item.root)
            }}
          >
            {item.name}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuNote>{t('Halo looks in the space folder and the folders directly inside it.')}</MenuNote>
      </Menu>
    </>
  )
}

function ScopePicker({ spaceId, repo, scope, review, snapshotMissing, onScope, layout }: TopBarProps) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const [picker, setPicker] = useState<'branch' | 'commit' | null>(null)
  const anchorRef = useRef<HTMLButtonElement>(null)

  const choose = (next: StoredCompareScope) => {
    setOpen(false)
    setPicker(null)
    if (!sameStoredScope(next, scope)) onScope(next)
  }

  const sinceReview = review && !snapshotMissing
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('Compare: {{scope}}', { scope: scopeLabel(scope, t) })}
        title={scopeLabel(scope, t)}
        className={`${TRIGGER} ${triggerHeight(layout)} min-w-[64px]`}
      >
        {!layout.hideMinorStats && <Clock3 size={14} className="shrink-0 text-faint-foreground" aria-hidden />}
        <span className="truncate">{scopeShortLabel(scope, t)}</span>
        <ChevronDown size={12} className="shrink-0" aria-hidden />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} label={t('Compare')}>
        <MenuItem checked={scope.kind === 'uncommitted'} description={t('HEAD ↔ working tree, untracked files included')} onSelect={() => choose({ kind: 'uncommitted' })}>
          {t('Uncommitted changes')}
        </MenuItem>
        <MenuItem checked={scope.kind === 'staged'} description={t('HEAD ↔ staged')} onSelect={() => choose({ kind: 'staged' })}>
          {t('Staged changes')}
        </MenuItem>
        <MenuItem
          checked={scope.kind === 'since-review'}
          disabled={!sinceReview}
          description={
            snapshotMissing ? t('The last review\'s snapshot is no longer available')
              : review ? t('Changes since the review at {{time}}', { time: formatTime(review.startedAt, i18n.language) })
                : t('Run a review first')
          }
          onSelect={() => choose({ kind: 'since-review' })}
        >
          {t('Since last review')}
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          checked={scope.kind === 'revision' && scope.mergeBase}
          description={scope.kind === 'revision' && scope.mergeBase ? scopeLabel(scope, t) : undefined}
          disabled={!repo || repo.unborn}
          onSelect={() => {
            setOpen(false)
            setPicker('branch')
          }}
        >
          {t('Compare with branch…')}
        </MenuItem>
        <MenuItem
          checked={scope.kind === 'revision' && !scope.mergeBase}
          description={scope.kind === 'revision' && !scope.mergeBase ? scopeLabel(scope, t) : undefined}
          disabled={!repo || repo.unborn}
          onSelect={() => {
            setOpen(false)
            setPicker('commit')
          }}
        >
          {t('Compare with commit…')}
        </MenuItem>
      </Menu>
      {repo && picker && (
        <RevisionPicker
          spaceId={spaceId}
          repoRoot={repo.root}
          kind={picker}
          anchorRef={anchorRef}
          onClose={() => setPicker(null)}
          onPick={(option) => choose({ kind: 'revision', revision: option.revision, mergeBase: option.kind === 'branch' || option.kind === 'remote-branch' })}
        />
      )}
    </>
  )
}

function RevisionPicker({ spaceId, repoRoot, kind, anchorRef, onClose, onPick }: {
  spaceId: string
  repoRoot: string
  kind: 'branch' | 'commit'
  anchorRef: RefObject<HTMLButtonElement>
  onClose: () => void
  onPick: (option: GitRevisionOption) => void
}) {
  const { t, i18n } = useTranslation()
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<GitRevisionOption[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    gitClient.listRevisionOptions(spaceId, repoRoot).then(
      (found) => { if (!cancelled) setOptions(found) },
      (e: unknown) => { if (!cancelled) setError(gitErrorMessage(failureOf(e), t)) }
    )
    return () => {
      cancelled = true
    }
  }, [spaceId, repoRoot, t])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matches = (option: GitRevisionOption) => !q || option.revision.toLowerCase().includes(q) || option.subject?.toLowerCase().includes(q)
    const of = (k: GitRevisionOption['kind']) => (options ?? []).filter((o) => o.kind === k && matches(o))
    return kind === 'branch'
      ? [{ title: t('Branches'), items: of('branch') }, { title: t('Remote branches'), items: of('remote-branch') }]
      : [{ title: t('Tags'), items: of('tag') }, { title: t('Recent commits'), items: of('commit') }]
  }, [options, query, kind, t])

  return (
    <Menu open onClose={onClose} anchorRef={anchorRef} label={kind === 'branch' ? t('Compare with branch…') : t('Compare with commit…')} className="w-[min(92vw,340px)]">
      <label className="mx-1 mb-1 flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2 focus-within:border-primary">
        <Search size={13} className="shrink-0 text-faint-foreground" aria-hidden />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('Search branches, tags and commits…')}
          aria-label={t('Search branches, tags and commits…')}
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-subtle-foreground"
        />
      </label>
      {kind === 'branch' && <MenuNote>{t('Compared from where it forked')}</MenuNote>}
      {!options && !error && (
        <div className="flex items-center gap-2 px-2 py-2 text-[12px] text-subtle-foreground">
          <Loader2 size={13} className="animate-spin" aria-hidden />{t('Loading…')}
        </div>
      )}
      {error && <MenuNote>{error}</MenuNote>}
      {groups.map((group) => group.items.length > 0 && (
        <div key={group.title}>
          <MenuLabel>{group.title}</MenuLabel>
          {group.items.map((option) => (
            <MenuItem
              key={`${option.kind}:${option.revision}`}
              icon={option.kind === 'commit' ? undefined : <GitBranch size={13} />}
              description={option.kind === 'commit' && option.date ? `${revisionName(option.revision)} · ${formatTime(Date.parse(option.date), i18n.language)}` : undefined}
              onSelect={() => onPick(option)}
            >
              {option.kind === 'commit' ? option.subject || revisionName(option.revision) : option.revision}
            </MenuItem>
          ))}
        </div>
      ))}
      {options && groups.every((group) => group.items.length === 0) && <MenuNote>{t('No matches')}</MenuNote>}
    </Menu>
  )
}

function PageSwitch({ page, onPage, full = false, showBadge }: { page: ChangesPage; onPage: (page: ChangesPage) => void; full?: boolean; showBadge: boolean }) {
  const { t } = useTranslation()
  const pages: ChangesPage[] = ['changes', 'overview', 'graph']
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const step = e.key === 'ArrowRight' ? 1 : -1
    const next = pages[(pages.indexOf(page) + step + pages.length) % pages.length]
    onPage(next)
    ;(e.currentTarget.querySelector(`[data-page="${next}"]`) as HTMLElement | null)?.focus()
  }
  const label = (item: ChangesPage) =>
    item === 'changes' ? t('Changes') : item === 'graph' ? t('Graph') : t('Overview & review')
  return (
    <div role="tablist" aria-label={t('Changes')} onKeyDown={onKeyDown} className={`inline-flex shrink-0 rounded-md bg-secondary p-0.5 ${full ? 'w-full' : ''}`}>
      {pages.map((item) => {
        const selected = item === page
        return (
          <button
            key={item}
            type="button"
            role="tab"
            data-page={item}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onPage(item)}
            // Full width on phones: a taller tab whose touch area reaches 40px.
            className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[5px] px-2.5 text-[12.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 ${
              full ? "relative h-8 flex-1 before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']" : 'h-6'
            } ${
              selected ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {label(item)}
            {item === 'overview' && showBadge && (
              <span className="rounded bg-primary/15 px-1 text-[10px] font-medium text-primary">{t('AI')}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
