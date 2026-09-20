/**
 * AutomationCardWall
 *
 * Card-wall replacement for the digital-human list. Groups apps by runtime
 * status ("needs me" / running / standing by / paused / uninstalled), and
 * offers a search + scope filter + sort toolbar shared in spirit with the
 * (future) Skill and MCP card walls.
 */

import { useEffect, useMemo, useState } from 'react'
import { Bot, ChevronRight, Plus, Search, Store } from 'lucide-react'
import type { InstalledApp } from '../../../shared/apps/app-types'
import { useAppsStore } from '../../stores/apps.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { resolveSpecI18n } from '../../utils/spec-i18n'
import { deriveAutomationStatus } from '../../utils/automation-status'
import { AutomationCard } from './AutomationCard'

interface AutomationCardWallProps {
  spaceMap: Record<string, string>
  onInstall: () => void
  onBrowseStore: () => void
}

interface CardGroup {
  key: string
  label: string
  apps: InstalledApp[]
  defaultCollapsed?: boolean
}

function groupApps(apps: InstalledApp[], appStates: ReturnType<typeof useAppsStore.getState>['appStates']): CardGroup[] {
  const needsMe: InstalledApp[] = []
  const running: InstalledApp[] = []
  const standingBy: InstalledApp[] = []
  const paused: InstalledApp[] = []
  const uninstalled: InstalledApp[] = []

  for (const app of apps) {
    if (app.status === 'uninstalled') { uninstalled.push(app); continue }
    const status = deriveAutomationStatus(app.status, appStates[app.id]?.status)
    if (status === 'waiting_user' || status === 'error' || status === 'needs_login') needsMe.push(app)
    else if (status === 'running' || status === 'queued') running.push(app)
    else if (status === 'paused') paused.push(app)
    else standingBy.push(app)
  }

  const groups: CardGroup[] = []
  if (needsMe.length) groups.push({ key: 'needs-me', label: 'Needs you', apps: needsMe })
  if (running.length) groups.push({ key: 'running', label: 'Running', apps: running })
  if (standingBy.length) groups.push({ key: 'standing-by', label: 'Standing by', apps: standingBy })
  if (paused.length) groups.push({ key: 'paused', label: 'Paused', apps: paused })
  if (uninstalled.length) groups.push({ key: 'uninstalled', label: 'Uninstalled', apps: uninstalled, defaultCollapsed: true })
  return groups
}

export function AutomationCardWall({ spaceMap, onInstall, onBrowseStore }: AutomationCardWallProps) {
  const { t } = useTranslation()
  const apps = useAppsStore(s => s.apps)
  const appStates = useAppsStore(s => s.appStates)
  const overview = useAppsStore(s => s.overview)
  const loadOverview = useAppsStore(s => s.loadOverview)
  const selectApp = useAppsPageStore(s => s.selectApp)
  const openAppOverview = useAppsPageStore(s => s.openAppOverview)

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [scopeFilter, setScopeFilter] = useState<string>('all')
  // Tracks which collapsible groups the user opened, rather than which they
  // closed. Seeded with 'uninstalled' so that one group starts expanded —
  // apps living there can still be reinstalled or deleted, worth surfacing.
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['uninstalled']))

  // Refresh runtime state + latest summaries + recent runs on every visit —
  // apps/appStates are usually already warm from cold-start loading, this
  // call only tops them up.
  useEffect(() => {
    void loadOverview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(id)
  }, [search])

  const automationApps = useMemo(() => apps.filter(a => a.spec.type === 'automation'), [apps])

  const spaceOptions = useMemo(() => {
    const ids = new Set<string>()
    for (const a of automationApps) if (a.spaceId) ids.add(a.spaceId)
    return Array.from(ids).map(id => ({ id, name: spaceMap[id] ?? id }))
  }, [automationApps, spaceMap])

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase()
    return automationApps.filter(app => {
      if (scopeFilter === 'global' && app.spaceId !== null) return false
      if (scopeFilter !== 'all' && scopeFilter !== 'global' && app.spaceId !== scopeFilter) return false
      if (!q) return true
      const { name, description } = resolveSpecI18n(app.spec, getCurrentLanguage())
      return name.toLowerCase().includes(q) || (description ?? '').toLowerCase().includes(q)
    })
  }, [automationApps, debouncedSearch, scopeFilter])

  const groups = useMemo<CardGroup[]>(() => {
    return groupApps(filtered, appStates)
  }, [filtered, appStates])

  const toggleExpanded = (key: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const isEmptyOverall = automationApps.length === 0
  const isEmptyFiltered = !isEmptyOverall && groups.length === 0

  if (isEmptyOverall) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 sm:p-8 text-center">
        <div className="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center">
          <Bot className="w-6 h-6 text-muted-foreground" />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">{t('No digital humans yet')}</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-xs">
            {t('Tell the AI in any workspace conversation, or create one manually below')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onInstall}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-primary hover:bg-primary/10 rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" /> {t('Create Digital Human')}
          </button>
          <button
            onClick={onBrowseStore}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
          >
            <Store className="w-4 h-4" /> {t('Install from Marketplace')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex-shrink-0 flex items-center gap-2 py-2.5">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('Search digital humans')}
            className="w-full pl-9 pr-3 py-2 text-[13px] bg-card border border-border/60 rounded-lg focus:outline-none focus:border-primary focus:shadow-[inset_0_0_0_1px_var(--primary)] text-foreground placeholder:text-muted-foreground/50"
          />
        </div>

        <select
          value={scopeFilter}
          onChange={e => setScopeFilter(e.target.value)}
          className="flex-shrink-0 px-3 py-2 text-[13px] bg-card border border-border/60 rounded-lg text-muted-foreground hover:text-foreground hover:border-border transition-colors focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="all">{t('All workspaces')}</option>
          <option value="global">{t('Global')}</option>
          {spaceOptions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>

        <button
          onClick={onInstall}
          className="flex-shrink-0 flex items-center gap-1.5 px-3 py-2 text-[13px] border border-border/60 bg-card text-muted-foreground rounded-lg hover:text-foreground hover:border-border transition-colors"
        >
          <Plus className="w-4 h-4" />
          {t('Create Digital Human')}
        </button>
        <button
          onClick={onBrowseStore}
          className="flex-shrink-0 flex items-center gap-1.5 px-3 py-2 text-[13px] border border-border/60 bg-card text-muted-foreground rounded-lg hover:text-foreground hover:border-border transition-colors"
        >
          <Store className="w-4 h-4" />
          {t('Install from Marketplace')}
        </button>
      </div>

      {/* Card grid */}
      <div className="flex-1 overflow-y-auto py-3">
        {isEmptyFiltered ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <p className="text-sm text-foreground">{t('No matching digital humans')}</p>
            <button
              onClick={() => { setSearch(''); setScopeFilter('all') }}
              className="text-xs text-primary hover:underline"
            >
              {t('Clear filters')}
            </button>
          </div>
        ) : (
          <div className="space-y-5">
            {groups.map(group => {
              const collapsible = group.defaultCollapsed !== undefined
              const isOpen = !group.defaultCollapsed || expanded.has(group.key)
              return (
              <div key={group.key}>
                {group.label && (
                  <button
                    onClick={() => collapsible && toggleExpanded(group.key)}
                    className={`flex items-center gap-1.5 mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-1 ${collapsible ? 'cursor-pointer hover:text-foreground transition-colors' : 'cursor-default'}`}
                  >
                    {group.key === 'needs-me' && <span className="w-1.5 h-1.5 rounded-full bg-halo-warning flex-shrink-0" />}
                    {group.key === 'running' && <span className="w-2.5 h-2.5 rounded-full border-[1.5px] border-primary border-t-transparent animate-spin flex-shrink-0" />}
                    {t(group.label)}
                    <span className="font-normal normal-case tracking-normal">({group.apps.length})</span>
                    {collapsible && <ChevronRight className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-90' : ''}`} />}
                  </button>
                )}
                {isOpen && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
                    {group.apps.map(app => (
                      <AutomationCard
                        key={app.id}
                        app={app}
                        overview={overview[app.id]}
                        spaceLabel={app.spaceId ? (spaceMap[app.spaceId] ?? app.spaceId) : t('Global')}
                        onOpen={() => selectApp(app.id, app.spec.type, app.spaceId ?? undefined)}
                        onOpenEscalation={() => openAppOverview(app.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
