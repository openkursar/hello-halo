import { useShallow } from 'zustand/react/shallow'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUpRight, ChevronDown, ChevronRight, FolderInput, MessageSquare, MoreVertical, Play, Plus, Search, Unplug, Users } from 'lucide-react'
import { usePeopleDirectoryStore } from '../../stores/people-directory.store'
import { api } from '../../api'
import { useAppsStore } from '../../stores/apps.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { usePeopleViewStore } from '../../stores/people-view.store'
import { useTeamStore } from '../../stores/team.store'
import { openDigitalHumanChat } from '../../utils/conversation-navigation'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { AutomationAvatar } from './AutomationAvatar'
import { PersonStatusDot } from './PersonStatusDot'
import { describePersonStatus } from '../../utils/automation-status'
import { WorkspaceMigrationDialog } from './WorkspaceMigrationDialog'
import { needsAttention } from '../../../shared/apps/app-types'
import type { PeopleDirectoryQuery, PeopleDirectorySummary } from '../../../shared/apps/people-directory'
import type { TeamUpdatedChange } from '../../../shared/apps/team-types'

interface DirectoryGroup {
  key: string
  /** Untranslated label; rendered through t() so extraction sees the literal. */
  label: string
  apps: PeopleDirectorySummary[]
}

/**
 * The directory doubles as a status board: people who need the user come
 * first as their own group, not as a counter to click through. Grouping is
 * per page — the server orders and paginates, this only arranges the page.
 *
 * `needsAttention` is the shared definition, so a card cannot land in "needs
 * you" for a reason its own page and its own footer do not recognise.
 */
function groupRows(rows: PeopleDirectorySummary[]): DirectoryGroup[] {
  const needsMe: PeopleDirectorySummary[] = []
  const running: PeopleDirectorySummary[] = []
  const standingBy: PeopleDirectorySummary[] = []
  const paused: PeopleDirectorySummary[] = []
  for (const app of rows) {
    const state = app.state
    if (needsAttention(state)) needsMe.push(app)
    else if (state?.status === 'running' || state?.status === 'queued') running.push(app)
    else if (state?.automaticEnabled === false || app.status === 'paused') paused.push(app)
    else standingBy.push(app)
  }
  return [
    { key: 'needs-me', label: 'Needs you', apps: needsMe },
    { key: 'running', label: 'Running', apps: running },
    { key: 'standing-by', label: 'Standing by', apps: standingBy },
    { key: 'paused', label: 'Paused', apps: paused },
  ].filter(group => group.apps.length > 0)
}

export function PeopleDirectory({ spaceMap, onCreate }: { spaceMap: Record<string, string>; onCreate: () => void }) {
  const { t } = useTranslation()
  const prefs = usePeopleViewStore(useShallow(state => ({ query: state.query, team: state.team, space: state.space, page: state.page, setFilters: state.setFilters })))
  const teams = useTeamStore(state => state.teams).filter(team => !team.ephemeral)
  const { data, loading, error, load, refresh } = usePeopleDirectoryStore()
  const scroll = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { if (scroll.current) scroll.current.scrollTop = usePeopleViewStore.getState().directoryScroll }, [])
  const language = getCurrentLanguage()
  useEffect(() => {
    const timer = setTimeout(() => void load({ q: prefs.query, language, teamId: prefs.team || undefined, spaceId: prefs.space || undefined, limit: 24, offset: (prefs.page - 1) * 24 }), 150)
    return () => clearTimeout(timer)
  }, [prefs.query, prefs.team, prefs.space, prefs.page, language, load])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const update = () => { if (!timer) timer = setTimeout(() => { timer = undefined; void refresh() }, 250) }
    // A team event matters here only when it can change who belongs to which
    // team or what the team is called; board and task-list churn cannot.
    const onTeam = (data: unknown) => {
      const changed = (data as { changed?: TeamUpdatedChange[] } | null)?.changed
      if (!changed || changed.includes('members')) update()
    }
    const off = [api.onAppStatusChanged(update), api.onAppListChanged(update), api.onTeamUpdated(onTeam)]
    return () => { off.forEach(unsubscribe => unsubscribe()); if (timer) clearTimeout(timer) }
  }, [refresh])
  const rows = data?.items ?? []
  const total = data?.total ?? 0
  const page = prefs.page
  const waiting = data?.attentionTotal ?? 0
  const filtering = !!(prefs.query || prefs.team || prefs.space)
  useEffect(() => { if (!loading && data && page > 1 && data.total <= (page - 1) * 24) prefs.setFilters({ page: Math.max(1, Math.ceil(data.total / 24)) }) }, [data, loading, page, prefs.setFilters])
  const open = (app: PeopleDirectorySummary, chat = false) => {
    usePeopleViewStore.setState({ returnInbox: false, returnTeam: null })
    if (app.status === 'uninstalled') useAppsPageStore.getState().selectApp(app.id, 'uninstalled')
    else if (chat && app.spaceId) void openDigitalHumanChat(app.id, app.spaceId)
    else useAppsPageStore.getState().openActivityThread(app.id)
  }
  const renderRows = (items: PeopleDirectorySummary[]) => (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">{items.map(app => <PersonCard key={app.id} app={app} spaceMap={spaceMap} onOpen={open} />)}</div>
  )
  const groups = groupRows(rows)
  const removedTotal = data?.removedTotal ?? 0
  return <div ref={scroll} onScroll={event => usePeopleViewStore.setState({ directoryScroll: event.currentTarget.scrollTop })} className="min-h-0 flex-1 overflow-y-auto px-6 py-4 sm:px-10 sm:py-8">
    <div>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-xl font-semibold mb-1">{t('My Digital Humans')} <span className="text-sm font-normal text-muted-foreground">{total}</span></h1><p className="text-[13px] text-muted-foreground">{t('Your digital humans, their work, and the teams they belong to.')}</p></div><button onClick={onCreate} className="flex min-h-10 items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground"><Plus size={16} />{t('Create Digital Human')}</button></header>
      <div className="mb-5 flex flex-wrap gap-2">
        <label className="relative min-w-0 grow sm:max-w-sm"><Search size={16} className="absolute left-3 top-3 text-muted-foreground" /><input aria-label={t('Search digital humans')} placeholder={t('Search names, roles, or teams')} value={prefs.query} onChange={event => prefs.setFilters({ query: event.target.value })} className="min-h-10 w-full rounded-lg border border-border-soft bg-card py-2 pl-9 pr-3 text-sm focus:outline-none focus:border-primary" /></label>
        <div className="relative max-w-full">
          <select aria-label={t('Filter by team')} value={prefs.team} onChange={event => prefs.setFilters({ team: event.target.value })} className="min-h-10 w-full appearance-none rounded-lg border border-border-soft bg-card pl-3 pr-9 text-xs hover:border-border transition-colors focus:outline-none focus:ring-1 focus:ring-primary"><option value="">{t('All teams')}</option>{teams.map(team => <option value={team.id} key={team.id}>{team.name}</option>)}</select>
          <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
        </div>
        <div className="relative max-w-full">
          <select aria-label={t('Filter by workspace')} value={prefs.space} onChange={event => prefs.setFilters({ space: event.target.value })} className="min-h-10 w-full appearance-none rounded-lg border border-border-soft bg-card pl-3 pr-9 text-xs hover:border-border transition-colors focus:outline-none focus:ring-1 focus:ring-primary"><option value="">{t('All workspaces')}</option>{Object.entries(spaceMap).map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select>
          <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
        </div>
        {/* The only way into the requests inbox. `waiting` counts the whole
            directory, so this cannot hang off the page's own "Needs you" group:
            the server orders by install date, and the people waiting may all be
            on another page or outside the filters. */}
        {waiting > 0 && (
          <button onClick={() => useAppsPageStore.getState().setCurrentTab('inbox')} className="ml-auto flex min-h-10 items-center gap-1 text-xs text-halo-warning hover:underline">
            {t('Handle all ({{count}})', { count: waiting })}<ArrowUpRight size={13} />
          </button>
        )}
      </div>
      {error && <div role="alert" className="mb-4 rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{t('Could not load digital humans.')} <button onClick={() => void refresh()} className="underline">{t('Retry')}</button></div>}
      {(!data || loading) && !error && !rows.length && <p role="status" className="py-12 text-center text-muted-foreground">{t('Loading…')}</p>}
      {data && !loading && !error && !rows.length && <div className="rounded-xl border border-dashed border-border p-10 text-center"><Users className="mx-auto mb-3 text-muted-foreground" /><h2 className="font-medium">{filtering ? t('No matching digital humans') : t('No digital humans yet')}</h2><button onClick={() => filtering ? prefs.setFilters({ query: '', team: '', space: '' }) : onCreate()} className="mt-3 text-sm text-primary">{filtering ? t('Clear filters') : t('Create Digital Human')}</button></div>}
      {groups.map(group => (
        <section key={group.key} className="mb-6">
          <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
            <h2 className={`text-[11px] font-semibold uppercase tracking-wider ${group.key === 'needs-me' ? 'text-halo-warning' : 'text-muted-foreground'}`}>
              {group.key === 'needs-me' && <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-halo-warning align-middle" />}
              {t(group.label)} <span className="font-normal normal-case tracking-normal">({group.apps.length})</span>
            </h2>
          </div>
          {renderRows(group.apps)}
        </section>
      ))}
      {total > 24 && <div className="mt-5 flex items-center justify-between text-sm"><button disabled={page === 1} onClick={() => prefs.setFilters({ page: page - 1 })} className="rounded-lg border border-border px-3 py-2 disabled:opacity-40">{t('Previous')}</button><span className="text-muted-foreground">{t('Page {{page}} of {{count}}', { page, count: Math.ceil(total / 24) })}</span><button disabled={page * 24 >= total} onClick={() => prefs.setFilters({ page: page + 1 })} className="rounded-lg border border-border px-3 py-2 disabled:opacity-40">{t('Next')}</button></div>}
      {removedTotal > 0 && (
        <RemovedPeopleSection
          total={removedTotal}
          query={{ q: prefs.query, language, teamId: prefs.team || undefined, spaceId: prefs.space || undefined }}
          renderRows={renderRows}
        />
      )}
    </div>
  </div>
}

const REMOVED_PAGE_SIZE = 24

/**
 * Removed people sit below everyone else, collapsed. They have no runtime
 * status to group by and are rarely needed, so they are fetched only once the
 * section is opened rather than on every directory load. `total` is counted
 * with the same filters this list applies.
 */
function RemovedPeopleSection({ total, query, renderRows }: {
  total: number
  query: Omit<PeopleDirectoryQuery, 'removed' | 'limit' | 'offset'>
  renderRows: (items: PeopleDirectorySummary[]) => ReactNode
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [items, setItems] = useState<PeopleDirectorySummary[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const request = useRef(0)
  const loadFrom = (offset: number) => {
    const id = ++request.current
    setStatus('loading')
    api.appListPeople({ ...query, removed: true, limit: REMOVED_PAGE_SIZE, offset })
      .then(response => {
        if (id !== request.current) return
        if (!response.success || !response.data) throw new Error(response.error ?? 'Removed query rejected')
        const page = response.data.items
        setItems(previous => offset === 0 ? page : [...previous, ...page])
        setStatus('ready')
      })
      .catch(error => {
        if (id !== request.current) return
        console.warn('[PeopleDirectory] Removed query failed', { offset, error })
        setStatus('error')
      })
  }
  // Opening, a new filter, or a change in the count starts over from the first page.
  useEffect(() => {
    if (!expanded) return
    setItems([])
    loadFrom(0)
    return () => { request.current++ }
  }, [expanded, total, query.q, query.language, query.teamId, query.spaceId])
  return (
    <section className="mt-8">
      <button
        onClick={() => setExpanded(value => !value)}
        aria-expanded={expanded}
        className="mb-2 flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronRight className={`h-3 w-3 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        {t('Removed')} <span className="font-normal normal-case tracking-normal">({total})</span>
      </button>
      {expanded && (
        <>
          {items.length > 0 && renderRows(items)}
          {status === 'error' ? (
            <div role="alert" className="mt-3 px-1 text-sm text-destructive">
              {t('Could not load removed digital humans.')} <button onClick={() => loadFrom(items.length)} className="underline">{t('Retry')}</button>
            </div>
          ) : status === 'loading' ? (
            <p role="status" className="mt-3 px-1 text-sm text-muted-foreground">{t('Loading…')}</p>
          ) : items.length < total && (
            <button onClick={() => loadFrom(items.length)} className="mt-4 rounded-lg border border-border px-3 py-2 text-sm hover:bg-secondary transition-colors">
              {t('Show more')}
            </button>
          )}
        </>
      )}
    </section>
  )
}

function PersonCard({ app, spaceMap, onOpen }: {
  app: PeopleDirectorySummary
  spaceMap: Record<string, string>
  onOpen: (app: PeopleDirectorySummary, chat?: boolean) => void
}) {
  const { t } = useTranslation()
  const state = app.state
  const memberships = app.teams
  return (
    <article
      onClick={() => onOpen(app)}
      className={`avatar-alive-host group min-w-0 cursor-pointer rounded-xl border bg-card p-5 transition-[border-color,box-shadow,opacity] ${app.status === 'uninstalled' ? 'border-dashed border-border-soft opacity-60 hover:opacity-100' : 'border-border-soft hover:border-border hover:shadow-sm'}`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <button onClick={event => { event.stopPropagation(); onOpen(app) }} className="flex min-w-0 flex-1 items-center gap-3 text-left"><span className="avatar-alive-on-hover flex shrink-0"><AutomationAvatar name={app.name} size={42} /></span><h2 className="min-w-0 truncate font-medium" title={app.name}>{app.name}</h2></button>
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 max-sm:opacity-100">
          {app.spaceId && app.status !== 'uninstalled' && (
            <button aria-label={t('Chat with {{name}}', { name: app.name })} onClick={event => { event.stopPropagation(); onOpen(app, true) }} className="rounded-lg p-2 text-muted-foreground hover:bg-secondary"><MessageSquare size={16} /></button>
          )}
          {app.status !== 'uninstalled' && <PersonCardMenu app={app} />}
        </div>
      </div>
      <p className="my-3 min-w-0 flex-1 truncate text-sm text-muted-foreground" title={app.description}>{app.description || t('Digital human')}</p>
      <button onClick={event => { event.stopPropagation(); useAppsPageStore.getState().openAppTeams(app.id) }} className="flex max-w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-primary"><Users size={14} /><span className="truncate">{memberships.length ? memberships.slice(0, 2).map(team => team.name).join(' · ') : t('No teams yet')}</span>{memberships.length > 2 && <span>+{memberships.length - 2}</span>}</button>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border-soft pt-3 text-xs text-muted-foreground"><span title={app.spaceId ? t('Workspace: {{name}}', { name: spaceMap[app.spaceId] ?? t('Workspace unavailable') }) : t('Global — runs outside any workspace')}>{app.spaceId ? spaceMap[app.spaceId] ?? t('Workspace unavailable') : t('Global')}</span>      <PersonStatus app={app} /></div>
    </article>
  )
}

/**
 * A card's status line, from describePersonStatus like the switcher. Only
 * states a live person never has (removed, no runtime state yet) are decided here.
 */
function PersonStatus({ app }: { app: PeopleDirectorySummary }) {
  const { t } = useTranslation()
  const state = app.state
  if (app.status === 'uninstalled' || !state) {
    return (
      <span className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
        <span>{app.status === 'uninstalled' ? t('Uninstalled') : t('Status unavailable')}</span>
      </span>
    )
  }
  const { effective, label, flag } = describePersonStatus(app.status, state, t)
  return (
    <span className="flex items-center gap-1.5">
      <PersonStatusDot appStatus={app.status} effective={effective} flag={flag} />
      <span>{label}</span>
    </span>
  )
}

/** Hover menu with the list-level quick actions; everything else lives on the detail page. */
function PersonCardMenu({ app }: { app: PeopleDirectorySummary }) {
  const { t } = useTranslation()
  const { triggerApp, uninstallApp } = useAppsStore(useShallow(state => ({ triggerApp: state.triggerApp, uninstallApp: state.uninstallApp })))
  const { showConfirm, DialogComponent } = useConfirmDialog()
  const [open, setOpen] = useState(false)
  const [showWorkspaceDialog, setShowWorkspaceDialog] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    function handle(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])
  const busy = app.state?.status === 'running' || app.state?.status === 'queued'
  const handleUninstall = async () => {
    setOpen(false)
    const confirmed = await showConfirm({
      title: t('Uninstall this digital human?'),
      message: t('Its work history is kept. You can reinstall it later from the removed list in the directory.'),
      confirmLabel: t('Uninstall'),
      cancelLabel: t('Cancel'),
      variant: 'danger',
    })
    if (confirmed) await uninstallApp(app.id)
  }
  return (
    <div ref={menuRef} className="relative" onClick={event => event.stopPropagation()}>
      <button onClick={() => setOpen(value => !value)} title={t('More')} aria-label={t('More')} aria-expanded={open} className={`rounded-lg p-2 text-muted-foreground hover:bg-secondary ${open ? 'bg-secondary' : ''}`}>
        <MoreVertical size={16} />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 min-w-[190px] overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-lg">
          <button onClick={() => { setOpen(false); void triggerApp(app.id) }} disabled={busy} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted/60 disabled:opacity-40">
            <Play className="h-3.5 w-3.5 text-muted-foreground" />{busy ? t('Working') : t('Run now')}
          </button>
          <button onClick={() => { setOpen(false); setShowWorkspaceDialog(true) }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted/60">
            <FolderInput className="h-3.5 w-3.5 text-muted-foreground" />{t('Move to another workspace')}
          </button>
          <div className="my-1 border-t border-border" />
          <button onClick={() => void handleUninstall()} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-halo-error transition-colors hover:bg-halo-error/10">
            <Unplug className="h-3.5 w-3.5" />{t('Uninstall')}
          </button>
        </div>
      )}
      {DialogComponent}
      {showWorkspaceDialog && (
        <WorkspaceMigrationDialog appId={app.id} spaceId={app.spaceId} onClose={() => setShowWorkspaceDialog(false)} />
      )}
    </div>
  )
}
