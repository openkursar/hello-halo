import { useShallow } from 'zustand/react/shallow'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowUpRight, LayoutGrid, List, MessageSquare, Plus, Search, Users } from 'lucide-react'
import { usePeopleDirectoryStore } from '../../stores/people-directory.store'
import { api } from '../../api'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { usePeopleViewStore } from '../../stores/people-view.store'
import { useTeamStore } from '../../stores/team.store'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { AutomationAvatar } from './AutomationAvatar'
import type { PeopleDirectorySummary } from '../../../shared/apps/people-directory'

export function PeopleDirectory({ spaceMap, onCreate }: { spaceMap: Record<string, string>; onCreate: () => void }) {
  const { t } = useTranslation()
  const prefs = usePeopleViewStore(useShallow(state => ({ query: state.query, team: state.team, space: state.space, attention: state.attention, view: state.view, page: state.page, setFilters: state.setFilters, rememberPerson: state.rememberPerson })))
  const teams = useTeamStore(state => state.teams)
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
  const pending = data?.pendingTotal ?? 0
  const filtering = !!(prefs.query || prefs.team || prefs.space || prefs.attention)
  useEffect(() => { if (!loading && data && page > 1 && data.total <= (page - 1) * 24) prefs.setFilters({ page: Math.max(1, Math.ceil(data.total / 24)) }) }, [data, loading, page, prefs.setFilters])
  const open = (app: PeopleDirectorySummary, chat = false) => {
    usePeopleViewStore.setState({ returnInbox: false, returnTeam: null })
    prefs.rememberPerson(app.id)
    if (app.status === 'uninstalled') useAppsPageStore.getState().selectApp(app.id, 'uninstalled', app.spaceId ?? undefined)
    else if (chat && app.spaceId) useAppsPageStore.getState().openAppChat(app.id, app.spaceId)
    else useAppsPageStore.getState().openActivityThread(app.id)
  }
  return <div ref={scroll} onScroll={event => usePeopleViewStore.setState({ directoryScroll: event.currentTarget.scrollTop })} className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-8">
    <div className="mx-auto max-w-6xl">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold">{t('My Digital Humans')} <span className="text-base font-normal text-muted-foreground">{total}</span></h1><p className="mt-2 text-sm text-muted-foreground">{t('Your people, their work, and the teams they belong to.')}</p></div><button onClick={onCreate} className="flex min-h-10 items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground"><Plus size={16} />{t('Create Digital Human')}</button></header>
      {(showRemoved || (data?.removedTotal ?? 0) > 0) && <button onClick={() => { setShowRemoved(value => !value); prefs.setFilters({ page: 1 }) }} className="mb-4 min-h-8 text-xs text-muted-foreground hover:text-primary">{showRemoved ? t('Show installed digital humans') : t('View removed digital humans')}</button>}
      {pending > 0 && <button onClick={() => prefs.setFilters({ attention: !prefs.attention })} className="mb-5 flex min-h-12 w-full items-center gap-3 rounded-xl border border-halo-warning/25 bg-halo-warning/5 px-4 py-3 text-left text-sm text-halo-warning"><AlertCircle size={18} /><span className="flex-1">{t('{{count}} requests need your answer', { count: pending })}</span><ArrowUpRight size={16} /></button>}
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
      <div className={prefs.view === 'cards' ? 'grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3' : 'divide-y divide-border rounded-xl border border-border'}>{rows.map(app => {
        const spec = app, memberships = app.teams, state = app.state
        return <article key={app.id} className={prefs.view === 'cards' ? 'min-w-0 rounded-xl border border-border bg-background p-5' : 'flex min-w-0 flex-wrap items-center gap-4 p-4'}>
          <div className="flex min-w-0 items-center gap-3"><button onClick={() => open(app)} className="flex min-w-0 flex-1 items-center gap-3 text-left"><AutomationAvatar name={spec.name} size={42} /><h2 className="min-w-0 truncate font-medium" title={spec.name}>{spec.name}</h2></button><button aria-label={t('Chat with {{name}}', { name: spec.name })} onClick={() => open(app, true)} className="rounded-lg p-2 text-muted-foreground hover:bg-secondary"><MessageSquare size={16} /></button></div>
          <p className="my-3 min-w-0 flex-1 truncate text-sm text-muted-foreground" title={spec.description}>{spec.description || t('Digital human')}</p>
          <button onClick={() => { useAppsPageStore.getState().openAppTeams(app.id); prefs.rememberPerson(app.id) }} className="flex max-w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-primary"><Users size={14} /><span className="truncate">{memberships.length ? memberships.slice(0, 2).map(team => team.name).join(' · ') : t('No teams yet')}</span>{memberships.length > 2 && <span>+{memberships.length - 2}</span>}</button>
          <div className={`flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground ${prefs.view === 'cards' ? 'mt-4 border-t border-border pt-3' : ''}`}><span>{app.spaceId ? spaceMap[app.spaceId] ?? t('Workspace unavailable') : t('Global')}</span><span>{(state?.pendingDecisionCount ?? 0) > 0 ? t('{{count}} waiting', { count: state!.pendingDecisionCount }) : state?.status === 'running' ? t('Working') : state?.automaticEnabled === false || app.status === 'paused' ? t('Automatic tasks paused') : app.status === 'uninstalled' ? t('Uninstalled') : !state ? t('Status unavailable') : t('Ready')}</span></div>
        </article>
      })}</div>
      {total > 24 && <div className="mt-5 flex items-center justify-between text-sm"><button disabled={page === 1} onClick={() => prefs.setFilters({ page: page - 1 })} className="rounded-lg border border-border px-3 py-2 disabled:opacity-40">{t('Previous')}</button><span className="text-muted-foreground">{t('Page {{page}} of {{count}}', { page, count: Math.ceil(total / 24) })}</span><button disabled={page * 24 >= total} onClick={() => prefs.setFilters({ page: page + 1 })} className="rounded-lg border border-border px-3 py-2 disabled:opacity-40">{t('Next')}</button></div>}
    </div>
  </div>
}
