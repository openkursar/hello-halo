import { useShallow } from 'zustand/react/shallow'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUpRight, FolderInput, LayoutGrid, List, MessageSquare, MoreVertical, Play, Plus, Search, Unplug, Users } from 'lucide-react'
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
import { WorkspaceMigrationDialog } from './WorkspaceMigrationDialog'
import { needsAttention } from '../../../shared/apps/app-types'
import type { PeopleDirectorySummary } from '../../../shared/apps/people-directory'

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
  const prefs = usePeopleViewStore(useShallow(state => ({ query: state.query, team: state.team, space: state.space, attention: state.attention, view: state.view, page: state.page, setFilters: state.setFilters })))
  const teams = useTeamStore(state => state.teams).filter(team => !team.ephemeral)
  const { data, loading, error, load, refresh } = usePeopleDirectoryStore()
  const [showRemoved, setShowRemoved] = useState(false)
  const scroll = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { if (scroll.current) scroll.current.scrollTop = usePeopleViewStore.getState().directoryScroll }, [])
  const language = getCurrentLanguage()
  useEffect(() => {
    const timer = setTimeout(() => void load({ q: prefs.query, language, teamId: prefs.team || undefined, spaceId: prefs.space || undefined, attention: prefs.attention, removed: showRemoved, limit: 24, offset: (prefs.page - 1) * 24 }), 150)
    return () => clearTimeout(timer)
  }, [prefs.query, prefs.team, prefs.space, prefs.attention, prefs.page, showRemoved, language, load])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const update = () => { if (!timer) timer = setTimeout(() => { timer = undefined; void refresh() }, 250) }
    const off = [api.onAppStatusChanged(update), api.onAppListChanged(update), api.onTeamUpdated(update)]
    return () => { off.forEach(unsubscribe => unsubscribe()); if (timer) clearTimeout(timer) }
  }, [refresh])
  const rows = data?.items ?? []
  const total = data?.total ?? 0
  const page = prefs.page
  const waiting = data?.attentionTotal ?? 0
  const filtering = !!(prefs.query || prefs.team || prefs.space || prefs.attention)
  useEffect(() => { if (!loading && data && page > 1 && data.total <= (page - 1) * 24) prefs.setFilters({ page: Math.max(1, Math.ceil(data.total / 24)) }) }, [data, loading, page, prefs.setFilters])
  const open = (app: PeopleDirectorySummary, chat = false) => {
    usePeopleViewStore.setState({ returnInbox: false, returnTeam: null })
    if (app.status === 'uninstalled') useAppsPageStore.getState().selectApp(app.id, 'uninstalled')
    else if (chat && app.spaceId) void openDigitalHumanChat(app.id, app.spaceId)
    else useAppsPageStore.getState().openActivityThread(app.id)
  }
  const rowContainerClass = prefs.view === 'cards' ? 'grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3' : 'divide-y divide-border rounded-xl border border-border'
  const renderRows = (items: PeopleDirectorySummary[]) => (
    <div className={rowContainerClass}>{items.map(app => <PersonCard key={app.id} app={app} view={prefs.view} spaceMap={spaceMap} onOpen={open} />)}</div>
  )
  // Removed people share one flat list: they have no runtime status to group by.
  const groups = showRemoved ? [] : groupRows(rows)
  return <div ref={scroll} onScroll={event => usePeopleViewStore.setState({ directoryScroll: event.currentTarget.scrollTop })} className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-8">
    <div className="mx-auto max-w-6xl">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold">{t('My Digital Humans')} <span className="text-base font-normal text-muted-foreground">{total}</span></h1><p className="mt-2 text-sm text-muted-foreground">{t('Your digital humans, their work, and the teams they belong to.')}</p></div><button onClick={onCreate} className="flex min-h-10 items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground"><Plus size={16} />{t('Create Digital Human')}</button></header>
      {(showRemoved || (data?.removedTotal ?? 0) > 0) && <button onClick={() => { setShowRemoved(value => !value); prefs.setFilters({ page: 1 }) }} className="mb-4 min-h-8 text-xs text-muted-foreground hover:text-primary">{showRemoved ? t('Show installed digital humans') : t('View removed digital humans')}</button>}
      <div className="mb-5 flex flex-wrap gap-2">
        <label className="relative min-w-0 grow sm:max-w-sm"><Search size={16} className="absolute left-3 top-3 text-muted-foreground" /><input aria-label={t('Search digital humans')} placeholder={t('Search names, roles, or teams')} value={prefs.query} onChange={event => prefs.setFilters({ query: event.target.value })} className="min-h-10 w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm" /></label>
        <select aria-label={t('Filter by team')} value={prefs.team} onChange={event => prefs.setFilters({ team: event.target.value })} className="min-h-10 max-w-full rounded-lg border border-border bg-background px-3 text-xs"><option value="">{t('All teams')}</option>{teams.map(team => <option value={team.id} key={team.id}>{team.name}</option>)}</select>
        <select aria-label={t('Filter by workspace')} value={prefs.space} onChange={event => prefs.setFilters({ space: event.target.value })} className="min-h-10 max-w-full rounded-lg border border-border bg-background px-3 text-xs"><option value="">{t('All workspaces')}</option>{Object.entries(spaceMap).map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select>
        <button aria-pressed={prefs.attention} onClick={() => prefs.setFilters({ attention: !prefs.attention })} className={`min-h-10 rounded-lg border px-3 text-xs ${prefs.attention ? 'border-halo-warning text-halo-warning' : 'border-border text-muted-foreground'}`}>{t('Needs my attention')}</button>
        <div className="ml-auto flex rounded-lg border border-border p-1">{(['cards', 'list'] as const).map(view => <button key={view} aria-label={view === 'cards' ? t('Card view') : t('List view')} aria-pressed={prefs.view === view} onClick={() => prefs.setFilters({ view })} className={`rounded p-2 ${prefs.view === view ? 'bg-secondary' : 'text-muted-foreground'}`}>{view === 'cards' ? <LayoutGrid size={16} /> : <List size={16} />}</button>)}</div>
      </div>
      {error && <div role="alert" className="mb-4 rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{t('Could not load digital humans.')} <button onClick={() => void refresh()} className="underline">{t('Retry')}</button></div>}
      {(!data || loading) && !error && !rows.length && <p role="status" className="py-12 text-center text-muted-foreground">{t('Loading…')}</p>}
      {data && !loading && !error && !rows.length && <div className="rounded-xl border border-dashed border-border p-10 text-center"><Users className="mx-auto mb-3 text-muted-foreground" /><h2 className="font-medium">{filtering ? t('No matching digital humans') : t('No digital humans yet')}</h2><button onClick={() => filtering ? prefs.setFilters({ query: '', team: '', space: '', attention: false }) : onCreate()} className="mt-3 text-sm text-primary">{filtering ? t('Clear filters') : t('Create Digital Human')}</button></div>}
      {showRemoved ? renderRows(rows) : groups.map(group => (
        <section key={group.key} className="mb-6">
          <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
            <h2 className={`text-[11px] font-semibold uppercase tracking-wider ${group.key === 'needs-me' ? 'text-halo-warning' : 'text-muted-foreground'}`}>
              {group.key === 'needs-me' && <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-halo-warning align-middle" />}
              {t(group.label)} <span className="font-normal normal-case tracking-normal">({group.apps.length})</span>
            </h2>
            {group.key === 'needs-me' && waiting > 0 && (
              <button onClick={() => useAppsPageStore.getState().setCurrentTab('inbox')} className="ml-auto flex min-h-8 items-center gap-1 text-xs text-halo-warning hover:underline">
                {t('Handle all ({{count}})', { count: waiting })}<ArrowUpRight size={13} />
              </button>
            )}
          </div>
          {renderRows(group.apps)}
        </section>
      ))}
      {total > 24 && <div className="mt-5 flex items-center justify-between text-sm"><button disabled={page === 1} onClick={() => prefs.setFilters({ page: page - 1 })} className="rounded-lg border border-border px-3 py-2 disabled:opacity-40">{t('Previous')}</button><span className="text-muted-foreground">{t('Page {{page}} of {{count}}', { page, count: Math.ceil(total / 24) })}</span><button disabled={page * 24 >= total} onClick={() => prefs.setFilters({ page: page + 1 })} className="rounded-lg border border-border px-3 py-2 disabled:opacity-40">{t('Next')}</button></div>}
    </div>
  </div>
}

function PersonCard({ app, view, spaceMap, onOpen }: {
  app: PeopleDirectorySummary
  view: 'cards' | 'list'
  spaceMap: Record<string, string>
  onOpen: (app: PeopleDirectorySummary, chat?: boolean) => void
}) {
  const { t } = useTranslation()
  const state = app.state
  const memberships = app.teams
  return (
    <article
      onClick={() => onOpen(app)}
      className={`group cursor-pointer transition-colors ${view === 'cards' ? 'min-w-0 rounded-xl border border-border bg-background p-5 hover:border-primary/40' : 'flex min-w-0 flex-wrap items-center gap-4 p-4 hover:bg-secondary/30'}`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <button onClick={event => { event.stopPropagation(); onOpen(app) }} className="flex min-w-0 flex-1 items-center gap-3 text-left"><AutomationAvatar name={app.name} size={42} /><h2 className="min-w-0 truncate font-medium" title={app.name}>{app.name}</h2></button>
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 max-sm:opacity-100">
          {app.spaceId && app.status !== 'uninstalled' && (
            <button aria-label={t('Chat with {{name}}', { name: app.name })} onClick={event => { event.stopPropagation(); onOpen(app, true) }} className="rounded-lg p-2 text-muted-foreground hover:bg-secondary"><MessageSquare size={16} /></button>
          )}
          {app.status !== 'uninstalled' && <PersonCardMenu app={app} />}
        </div>
      </div>
      <p className="my-3 min-w-0 flex-1 truncate text-sm text-muted-foreground" title={app.description}>{app.description || t('Digital human')}</p>
      <button onClick={event => { event.stopPropagation(); useAppsPageStore.getState().openAppTeams(app.id) }} className="flex max-w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-primary"><Users size={14} /><span className="truncate">{memberships.length ? memberships.slice(0, 2).map(team => team.name).join(' · ') : t('No teams yet')}</span>{memberships.length > 2 && <span>+{memberships.length - 2}</span>}</button>
      <div className={`flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground ${view === 'cards' ? 'mt-4 border-t border-border pt-3' : ''}`}><span>{app.spaceId ? spaceMap[app.spaceId] ?? t('Workspace unavailable') : t('Global')}</span>{/* Ordered so the strongest claim wins: stopping a person also turns its
          automatic tasks off, so in any other order a stop reads as the owner's
          own pause. */}
      <span>{app.status === 'uninstalled' ? t('Uninstalled') : state?.blocked ? t('Stopped, waiting for you') : (state?.pendingDecisionCount ?? 0) > 0 ? t('{{count}} waiting', { count: state!.pendingDecisionCount }) : state?.status === 'running' ? t('Working') : state?.automaticEnabled === false || app.status === 'paused' ? t('Automatic tasks paused') : !state ? t('Status unavailable') : t('Ready')}</span></div>
    </article>
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
