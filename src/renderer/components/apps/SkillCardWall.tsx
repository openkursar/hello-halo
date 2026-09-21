/**
 * SkillCardWall
 *
 * Card-wall replacement for the Skill list. Groups installed Skills by
 * health (error / enabled / disabled / uninstalled), plus a fifth group for
 * skills that exist on disk but have no installed-app record — the runtime
 * loads them anyway (skill-discovery.ts is the actual source of truth), so
 * hiding them from this tab reads as "my skill disappeared".
 */

import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, ChevronRight, FolderOpen, Loader2, Puzzle, Search, Store, Upload } from 'lucide-react'
import { AppTypeIcon } from '../store/AppTypeIcon'
import type { InstalledApp, AvailableSkill } from '../../../shared/apps/app-types'
import { useAppsStore } from '../../stores/apps.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useSpaceStore } from '../../stores/space.store'
import { useCapabilityInventory } from '../../hooks/useCapabilityInventory'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { resolveSpecI18n } from '../../utils/spec-i18n'
import { matchesInstallSource, type InstallSourceFilter } from '../../utils/install-source'
import { toSkillDirName } from '../../../shared/skill-naming'
import { isElectron } from '../../api/transport'
import { api } from '../../api'
import { SkillCard } from './SkillCard'

interface SkillCardWallProps {
  spaceMap: Record<string, string>
  onBrowseStore: () => void
  onManualAdd: () => void
}

interface CardGroup {
  key: string
  label: string
  apps: InstalledApp[]
  defaultCollapsed?: boolean
}

/** Bounded-concurrency map, so a workspace with many spaces doesn't fire N requests at once. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

export function SkillCardWall({ spaceMap, onBrowseStore, onManualAdd }: SkillCardWallProps) {
  const { t } = useTranslation()
  const apps = useAppsStore(s => s.apps)
  const selectApp = useAppsPageStore(s => s.selectApp)
  const haloSpace = useSpaceStore(s => s.haloSpace)
  const spaces = useSpaceStore(s => s.spaces)

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [scopeFilter, setScopeFilter] = useState('all')
  const [sourceFilter, setSourceFilter] = useState<InstallSourceFilter>('all')
  const [discovered, setDiscovered] = useState<(AvailableSkill & { __spaceId: string })[]>([])
  const [discoveryLoading, setDiscoveryLoading] = useState(false)
  const inventory = useCapabilityInventory()

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(id)
  }, [search])

  const skillApps = useMemo(() => apps.filter(a => a.spec.type === 'skill'), [apps])

  // Scan disk for skills across every space the user has (skills are loaded
  // per-space + global at runtime — see skill-discovery.ts). Keyed on the
  // space list alone: which skills are on disk doesn't change when an app is
  // paused or uninstalled, and re-scanning on every `apps` mutation would fire
  // N space-scoped IPC calls per toggle.
  useEffect(() => {
    let cancelled = false
    const allSpaceIds = [
      ...(haloSpace ? [haloSpace.id] : []),
      ...spaces.map(s => s.id),
    ]
    if (allSpaceIds.length === 0) return
    setDiscoveryLoading(true)
    mapLimited(allSpaceIds, 4, async (spaceId) => {
      const res = await api.appListAvailableSkillsForSpace(spaceId)
      return res.success && Array.isArray(res.data) ? (res.data as AvailableSkill[]).map(s => ({ ...s, __spaceId: spaceId })) : []
    }).then(results => {
      if (cancelled) return
      // Dedupe globals (identical across every space's result) by path.
      const byPath = new Map<string, AvailableSkill & { __spaceId: string }>()
      for (const s of results.flat()) if (!byPath.has(s.path)) byPath.set(s.path, s)
      setDiscovered(Array.from(byPath.values()))
    }).finally(() => { if (!cancelled) setDiscoveryLoading(false) })
    return () => { cancelled = true }
  }, [haloSpace, spaces])

  /** On disk but with no install record, so this tab can't manage them. */
  const unmanaged = useMemo(() => discovered.filter(skill => !apps.some(a =>
    a.spec.type === 'skill' &&
    a.status !== 'uninstalled' &&
    (skill.scope === 'global' ? a.spaceId === null : a.spaceId === skill.__spaceId) &&
    toSkillDirName(a.specId) === skill.dirName
  )), [discovered, apps])

  const spaceOptions = useMemo(() => {
    const ids = new Set<string>()
    for (const a of skillApps) if (a.spaceId) ids.add(a.spaceId)
    return Array.from(ids).map(id => ({ id, name: spaceMap[id] ?? id }))
  }, [skillApps, spaceMap])

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase()
    return skillApps.filter(app => {
      if (scopeFilter === 'global' && app.spaceId !== null) return false
      if (scopeFilter !== 'all' && scopeFilter !== 'global' && app.spaceId !== scopeFilter) return false
      if (!matchesInstallSource(app, sourceFilter)) return false
      if (!q) return true
      const { name, description } = resolveSpecI18n(app.spec, getCurrentLanguage())
      return name.toLowerCase().includes(q) || (description ?? '').toLowerCase().includes(q)
    })
  }, [skillApps, debouncedSearch, scopeFilter, sourceFilter])

  /** Digital humans each skill reaches, from the usage inventory. */
  const usageByAppId = useMemo(() => {
    const counts = new Map<string, number>()
    for (const entry of inventory.data?.entries ?? []) counts.set(entry.appId, entry.consumers.length)
    return counts
  }, [inventory.data])

  const groups = useMemo<CardGroup[]>(() => {
    const error: InstalledApp[] = []
    const enabled: InstalledApp[] = []
    const disabled: InstalledApp[] = []
    const uninstalled: InstalledApp[] = []
    for (const app of filtered) {
      if (app.status === 'uninstalled') uninstalled.push(app)
      else if (app.status === 'error') error.push(app)
      else if (app.status === 'paused') disabled.push(app)
      else enabled.push(app)
    }
    const out: CardGroup[] = []
    if (error.length) out.push({ key: 'error', label: 'Error', apps: error })
    if (enabled.length) out.push({ key: 'enabled', label: 'Enabled', apps: enabled })
    if (disabled.length) out.push({ key: 'disabled', label: 'Disabled', apps: disabled })
    if (uninstalled.length) out.push({ key: 'uninstalled', label: 'Uninstalled', apps: uninstalled, defaultCollapsed: true })
    return out
  }, [filtered])

  // Tracks which collapsible groups the user opened, rather than which they
  // closed. Seeded with 'uninstalled' so that one group starts expanded —
  // apps living there can still be reinstalled or deleted, worth surfacing.
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['uninstalled']))
  const toggleExpanded = (key: string) => setExpanded(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  /** The unmanaged group has no install record to filter on, so it only shows in the unfiltered view. */
  const showUnmanaged = !debouncedSearch && scopeFilter === 'all' && sourceFilter === 'all' && (unmanaged.length > 0 || discoveryLoading)

  const isEmptyOverall = skillApps.length === 0 && unmanaged.length === 0 && !discoveryLoading
  const isEmptyFiltered = !isEmptyOverall && groups.length === 0 && !showUnmanaged

  if (isEmptyOverall) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 sm:p-8 text-center">
        <div className="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center">
          <Puzzle className="w-6 h-6 text-muted-foreground" />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">{t('No Skills installed yet')}</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-xs">{t('Browse the marketplace for ready-made Skills, or add one manually')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onManualAdd} className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-primary hover:bg-primary/10 rounded-lg transition-colors">
            <Upload className="w-4 h-4" /> {t('Manual Add Skill')}
          </button>
          <button onClick={onBrowseStore} className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors">
            <Store className="w-4 h-4" /> {t('Install from Marketplace')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-shrink-0 flex flex-wrap items-center gap-2 py-2.5">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('Search Skills')}
            className="w-full pl-9 pr-3 py-2 text-[13px] bg-card border border-border/60 rounded-lg focus:outline-none focus:border-primary focus:shadow-[inset_0_0_0_1px_var(--primary)] text-foreground placeholder:text-muted-foreground/50"
          />
        </div>
        <select value={scopeFilter} onChange={e => setScopeFilter(e.target.value)} aria-label={t('Scope')} className="flex-shrink-0 px-3 py-2 text-[13px] bg-card border border-border/60 rounded-lg text-muted-foreground hover:text-foreground hover:border-border transition-colors focus:outline-none focus:ring-1 focus:ring-primary">
          <option value="all">{t('All workspaces')}</option>
          <option value="global">{t('Global')}</option>
          {spaceOptions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value as InstallSourceFilter)} aria-label={t('Source')} className="flex-shrink-0 px-3 py-2 text-[13px] bg-card border border-border/60 rounded-lg text-muted-foreground hover:text-foreground hover:border-border transition-colors focus:outline-none focus:ring-1 focus:ring-primary">
          <option value="all">{t('All sources')}</option>
          <option value="store">{t('Store')}</option>
          <option value="manual">{t('Custom')}</option>
          <option value="builtin">{t('Built in')}</option>
        </select>
        {/* Also in the overall-empty state, but that one is unreachable once a
            single skill exists — manual add has to live here too. */}
        <button
          onClick={onManualAdd}
          className="flex-shrink-0 flex items-center gap-1.5 px-3 py-2 text-[13px] border border-border/60 bg-card text-muted-foreground rounded-lg hover:text-foreground hover:border-border transition-colors"
        >
          <Upload className="w-4 h-4" />
          {t('Manual Add Skill')}
        </button>
        <button onClick={onBrowseStore} className="flex-shrink-0 flex items-center gap-1.5 px-3 py-2 text-[13px] border border-border/60 bg-card text-muted-foreground rounded-lg hover:text-foreground hover:border-border transition-colors">
          <Store className="w-4 h-4" />
          {t('Install from Marketplace')}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-3">
        {isEmptyFiltered ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <p className="text-sm text-foreground">{t('No matching Skills')}</p>
            <button onClick={() => { setSearch(''); setScopeFilter('all'); setSourceFilter('all') }} className="text-xs text-primary hover:underline">
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
                    {group.key === 'error' && <span className="w-1.5 h-1.5 rounded-full bg-halo-error flex-shrink-0" />}
                    {t(group.label)}
                    <span className="font-normal normal-case tracking-normal">({group.apps.length})</span>
                    {collapsible && <ChevronRight className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-90' : ''}`} />}
                  </button>
                )}
                {isOpen && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
                    {group.apps.map(app => (
                      <SkillCard
                        key={app.id}
                        app={app}
                        spaceMap={spaceMap}
                        usageCount={usageByAppId.get(app.id)}
                        onOpen={() => selectApp(app.id, app.spec.type)}
                      />
                    ))}
                  </div>
                )}
              </div>
              )
            })}

            {/* Unmanaged group: not affected by search+scope filters */}
            {showUnmanaged && (
              <div>
                <div className="mb-2 px-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('Unmanaged')} <span className="font-normal normal-case tracking-normal">({unmanaged.length})</span>
                  </p>
                  <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                    {t('These skills work on disk but have no install record, so they can\'t be enabled/disabled or uninstalled here.')}
                  </p>
                </div>
                {discoveryLoading && unmanaged.length === 0 && (
                  <div className="flex items-center gap-2 px-1 py-3 text-xs text-muted-foreground">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    {t('Scanning skill folders…')}
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
                  {unmanaged.map(skill => (
                    <div key={skill.path} className="bg-card border border-dashed border-border rounded-lg p-4 opacity-60 hover:opacity-100 transition-opacity">
                      <div className="flex items-start gap-2.5">
                        <AppTypeIcon type="skill" name={skill.name} size="md" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <h3 className="text-sm font-semibold text-foreground truncate leading-tight">{skill.name}</h3>
                            <span className="flex-shrink-0 max-w-[45%] truncate text-[10px] text-muted-foreground px-1.5 py-0.5 rounded bg-secondary/70">
                              {skill.scope === 'global' ? t('Global') : (spaceMap[skill.__spaceId] ?? t('Workspace'))}
                            </span>
                          </div>
                        </div>
                      </div>
                      {skill.description && <p className="mt-2 text-xs text-muted-foreground line-clamp-2">{skill.description}</p>}
                      <div className="mt-2.5 flex items-center justify-between gap-2">
                        <span className="text-[11px] text-muted-foreground/70 truncate" title={skill.path}>{skill.path}</span>
                        {isElectron() && (
                          <button
                            onClick={() => api.showArtifactInFolder(skill.path)}
                            className="flex-shrink-0 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                          >
                            <FolderOpen className="w-3 h-3" /> {t('Open folder')}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                {!isElectron() && unmanaged.length > 0 && (
                  <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <AlertCircle className="w-3 h-3" /> {t('Open in the desktop client to reveal a skill folder.')}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
