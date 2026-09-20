/**
 * McpCardWall
 *
 * Card-wall replacement for the MCP list. Connection health IS the MCP
 * runtime state, so grouping follows it directly instead of the generic
 * active/paused split every other tab used. "Session-stale" gets its own
 * group deliberately separate from "needs me": that failure mode means
 * "retry automatically next message", and folding it into the same bucket
 * as a real connection failure would tell users to go fix a config that
 * isn't broken.
 */

import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, Plug, Search, Store, Upload } from 'lucide-react'
import type { InstalledApp } from '../../../shared/apps/app-types'
import { useAppsStore } from '../../stores/apps.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useAppStore } from '../../stores/app.store'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { resolveSpecI18n } from '../../utils/spec-i18n'
import { deriveMcpHealth } from '../../utils/mcpStatus'
import { api } from '../../api'
import { McpCard } from './McpCard'

interface McpCardWallProps {
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

export function McpCardWall({ spaceMap, onBrowseStore, onManualAdd }: McpCardWallProps) {
  const { t } = useTranslation()
  const apps = useAppsStore(s => s.apps)
  const mcpStatus = useAppStore(s => s.mcpStatus)
  const selectApp = useAppsPageStore(s => s.selectApp)

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [scopeFilter, setScopeFilter] = useState('all')
  // Tracks which collapsible groups the user opened, rather than which they
  // closed. Seeded with 'uninstalled' so that one group starts expanded —
  // apps living there can still be reinstalled or deleted, worth surfacing.
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['uninstalled']))

  const mcpApps = useMemo(() => apps.filter(a => a.spec.type === 'mcp'), [apps])

  // Cold-start probe: an MCP server that has never been probed this session
  // (no sdkEntry) reads as "unprobed" until something triggers a probe.
  // Probing costs nothing (native handshake, no agent session, no tokens —
  // see mcp-probe.ts) and the "no sdkEntry yet" condition is self-limiting:
  // once probed, every future mount is a no-op here.
  useEffect(() => {
    const toProbe = mcpApps.filter(a => a.status === 'active' && !mcpStatus.some(s => s.name === a.specId))
    if (toProbe.length === 0) return
    let cursor = 0
    const worker = async () => {
      while (cursor < toProbe.length) {
        const app = toProbe[cursor++]
        await api.probeMcpApp(app.id).catch(() => {})
      }
    }
    void Promise.all(Array.from({ length: Math.min(4, toProbe.length) }, worker))
    // Intentionally mount-only: re-running on every mcpStatus/mcpApps change
    // would re-fire a probe the instant its own result arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(id)
  }, [search])

  const spaceOptions = useMemo(() => {
    const ids = new Set<string>()
    for (const a of mcpApps) if (a.spaceId) ids.add(a.spaceId)
    return Array.from(ids).map(id => ({ id, name: spaceMap[id] ?? id }))
  }, [mcpApps, spaceMap])

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase()
    return mcpApps.filter(app => {
      if (scopeFilter === 'global' && app.spaceId !== null) return false
      if (scopeFilter !== 'all' && scopeFilter !== 'global' && app.spaceId !== scopeFilter) return false
      if (!q) return true
      const { name, description } = resolveSpecI18n(app.spec, getCurrentLanguage())
      if (name.toLowerCase().includes(q) || (description ?? '').toLowerCase().includes(q)) return true
      const sdkEntry = mcpStatus.find(s => s.name === app.specId)
      return sdkEntry?.tools?.some(tool => tool.toLowerCase().includes(q)) ?? false
    })
  }, [mcpApps, debouncedSearch, scopeFilter, mcpStatus])

  const groups = useMemo<CardGroup[]>(() => {
    const needsMe: InstalledApp[] = []
    const sessionStale: InstalledApp[] = []
    const connected: InstalledApp[] = []
    const unprobed: InstalledApp[] = []
    const disabled: InstalledApp[] = []
    const uninstalled: InstalledApp[] = []

    for (const app of filtered) {
      if (app.status === 'uninstalled') { uninstalled.push(app); continue }
      if (app.status === 'paused') { disabled.push(app); continue }
      const sdkEntry = mcpStatus.find(s => s.name === app.specId)
      const health = deriveMcpHealth(app, sdkEntry)
      if (health === 'session-stale') sessionStale.push(app)
      else if (health === 'failed' || health === 'needs-login') needsMe.push(app)
      else if (health === 'connected') connected.push(app)
      else unprobed.push(app)
    }

    const out: CardGroup[] = []
    if (needsMe.length) out.push({ key: 'needs-me', label: 'Needs you', apps: needsMe })
    if (sessionStale.length) out.push({ key: 'session-stale', label: 'Session issue', apps: sessionStale })
    if (connected.length) out.push({ key: 'connected', label: 'Connected', apps: connected })
    if (unprobed.length) out.push({ key: 'unprobed', label: 'Not yet tested', apps: unprobed })
    if (disabled.length) out.push({ key: 'disabled', label: 'Disabled', apps: disabled })
    if (uninstalled.length) out.push({ key: 'uninstalled', label: 'Uninstalled', apps: uninstalled, defaultCollapsed: true })
    return out
  }, [filtered, mcpStatus])

  const toggleExpanded = (key: string) => setExpanded(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  const isEmptyOverall = mcpApps.length === 0
  const isEmptyFiltered = !isEmptyOverall && groups.length === 0

  if (isEmptyOverall) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 sm:p-8 text-center">
        <div className="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center">
          <Plug className="w-6 h-6 text-muted-foreground" />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">{t('No MCP servers connected yet')}</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-xs">{t('Add an MCP server to extend the AI with tools and integrations')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onManualAdd} className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-primary hover:bg-primary/10 rounded-lg transition-colors">
            <Upload className="w-4 h-4" /> {t('Manual Add MCP')}
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
      <div className="flex-shrink-0 flex items-center gap-2 py-2.5">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('Search MCP servers or tools')}
            className="w-full pl-9 pr-3 py-2 text-[13px] bg-card border border-border/60 rounded-lg focus:outline-none focus:border-primary focus:shadow-[inset_0_0_0_1px_var(--primary)] text-foreground placeholder:text-muted-foreground/50"
          />
        </div>
        <select value={scopeFilter} onChange={e => setScopeFilter(e.target.value)} className="flex-shrink-0 px-3 py-2 text-[13px] bg-card border border-border/60 rounded-lg text-muted-foreground hover:text-foreground hover:border-border transition-colors focus:outline-none focus:ring-1 focus:ring-primary">
          <option value="all">{t('All workspaces')}</option>
          <option value="global">{t('Global')}</option>
          {spaceOptions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {/* Also in the overall-empty state, but that one is unreachable once a
            single MCP server exists — manual add has to live here too. */}
        <button onClick={onManualAdd} className="flex-shrink-0 flex items-center gap-1.5 px-3 py-2 text-[13px] border border-border/60 bg-card text-muted-foreground rounded-lg hover:text-foreground hover:border-border transition-colors">
          <Upload className="w-4 h-4" />
          {t('Manual Add MCP')}
        </button>
        <button onClick={onBrowseStore} className="flex-shrink-0 flex items-center gap-1.5 px-3 py-2 text-[13px] border border-border/60 bg-card text-muted-foreground rounded-lg hover:text-foreground hover:border-border transition-colors">
          <Store className="w-4 h-4" />
          {t('Install from Marketplace')}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-3">
        {isEmptyFiltered ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <p className="text-sm text-foreground">{t('No matching MCP servers')}</p>
            <button onClick={() => { setSearch(''); setScopeFilter('all') }} className="text-xs text-primary hover:underline">
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
                    {group.key === 'needs-me' && <span className="w-1.5 h-1.5 rounded-full bg-halo-error flex-shrink-0" />}
                    {group.key === 'session-stale' && <span className="w-1.5 h-1.5 rounded-full bg-halo-warning flex-shrink-0" />}
                    {t(group.label)}
                    <span className="font-normal normal-case tracking-normal">({group.apps.length})</span>
                    {collapsible && <ChevronRight className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-90' : ''}`} />}
                  </button>
                )}
                {isOpen && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
                    {group.apps.map(app => (
                      <McpCard
                        key={app.id}
                        app={app}
                        sdkEntry={mcpStatus.find(s => s.name === app.specId)}
                        spaceMap={spaceMap}
                        onOpen={() => selectApp(app.id, app.spec.type, app.spaceId ?? undefined)}
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
