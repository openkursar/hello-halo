/**
 * McpTab - "MCP" content for the space resource rail
 *
 * Read-only browse of every MCP server installed in this space or globally
 * (space overrides global) — calls the manager's existing
 * listEffectiveMcpApps(spaceId) rather than re-deriving the same merge
 * client-side (AppMcpDepsSection does that merge for a different purpose:
 * one digital human's *declared dependencies*, not "what's installed here").
 * No management actions; a row always jumps to that app's detail on the
 * digital-humans page, mirroring AppMcpDepsSection.openMcpDetail.
 */

import { useState, useEffect, useCallback } from 'react'
import { Wrench, Loader2 } from 'lucide-react'
import { api } from '../../api'
import { useSpaceStore } from '../../stores/space.store'
import { useAppStore } from '../../stores/app.store'
import { useAppsPageStore, tabForAppType } from '../../stores/apps-page.store'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { resolveSpecI18n } from '../../utils/spec-i18n'
import type { InstalledApp } from '../../../shared/apps/app-types'
import { SpaceResourceRow } from './SpaceResourceRow'

export function McpTab() {
  const { t } = useTranslation()
  const spaceId = useSpaceStore(state => state.currentSpace?.id ?? '')

  const [mcpApps, setMcpApps] = useState<InstalledApp[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!spaceId) {
      setMcpApps([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    api.appListEffectiveMcpApps(spaceId)
      .then(res => {
        if (cancelled) return
        setMcpApps(res.success && Array.isArray(res.data) ? res.data : [])
      })
      .catch(() => { if (!cancelled) setMcpApps([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [spaceId])

  const openDetail = useCallback((app: InstalledApp) => {
    useAppStore.getState().navigate('apps')
    const store = useAppsPageStore.getState()
    store.setCurrentTab(tabForAppType('mcp'))
    store.selectApp(app.id, 'mcp', app.spaceId ?? undefined)
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
      </div>
    )
  }

  if (mcpApps.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-4 py-8">
        <Wrench className="w-8 h-8 text-muted-foreground/40 mb-2" />
        <p className="text-xs text-muted-foreground">{t('No MCP servers installed in this space yet.')}</p>
      </div>
    )
  }

  return (
    <div className="p-2 space-y-1.5 overflow-y-auto h-full">
      {mcpApps.map(app => {
        const display = resolveSpecI18n(app.spec, getCurrentLanguage())
        return (
          <SpaceResourceRow
            key={app.id}
            icon={<Wrench className="w-4 h-4" />}
            name={display.name}
            description={display.description}
            scope={app.spaceId === null ? 'global' : 'space'}
            onClick={() => openDetail(app)}
          />
        )
      })}
    </div>
  )
}
