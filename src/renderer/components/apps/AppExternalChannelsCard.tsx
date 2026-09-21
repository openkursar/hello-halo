/**
 * AppExternalChannelsCard
 *
 * Bots and external channels for one digital human, shown in its settings next
 * to the bot binding it describes. Surfaces IM/HTTP sessions that exist outside
 * the main conversation board: these are the digital human's own external
 * traffic, not something the user started from Halo, so they stay an
 * observation-only surface here instead of appearing in the main board's
 * conversation list.
 *
 * - Unbound: weak-state row linking to the config page's notification
 *   section, where channel binding actually lives.
 * - Bound: one card per bot instance (never per-contact — a bot can have far
 *   more contacts than this card has room for). Clicking a row opens
 *   AppBotSessionsView, the session browser for that specific bot. The row
 *   below the list reuses the unbound state's styling to stay the way back to
 *   Settings once at least one bot is bound.
 *
 * Global apps (spaceId === null) never render this: IM dispatch requires
 * app.spaceId (see main/apps/runtime/dispatch-inbound.ts), so a global app
 * structurally cannot have any IM/HTTP session to show.
 */

import { useEffect, useState, useCallback } from 'react'
import { ChevronRight, Radio } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { api } from '../../api'
import { CHANNEL_LABELS } from './im-channel-labels'
import type { ImSessionRecord, ImChannelInstanceStatus } from '../../../shared/types/im-channel'

interface AppExternalChannelsCardProps {
  appId: string
  /** The app's own home space. Component renders nothing when null (global app). */
  spaceId: string | null
}

const POLL_INTERVAL_MS = 15_000

function formatLastActive(ts: number, t: (s: string, o?: Record<string, unknown>) => string): string {
  if (!ts) return '-'
  const diffDays = Math.floor((Date.now() - ts) / (1000 * 60 * 60 * 24))
  if (diffDays === 0) return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (diffDays === 1) return t('1d ago')
  if (diffDays < 30) return t('{{count}}d ago', { count: diffDays })
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function AppExternalChannelsCard({ appId, spaceId }: AppExternalChannelsCardProps) {
  const { t } = useTranslation()
  const openAppConfigAt = useAppsPageStore(s => s.openAppConfigAt)
  const openBotSessions = useAppsPageStore(s => s.openBotSessions)

  const [instances, setInstances] = useState<ImChannelInstanceStatus[]>([])
  const [sessions, setSessions] = useState<ImSessionRecord[]>([])

  const fetchAll = useCallback(async () => {
    try {
      const [instancesRes, sessionsRes] = await Promise.all([
        api.imChannelsStatus(),
        api.imSessionsList(appId),
      ])
      if (instancesRes.success && Array.isArray(instancesRes.data)) {
        setInstances((instancesRes.data as ImChannelInstanceStatus[]).filter(i => i.appId === appId))
      }
      if (sessionsRes.success && Array.isArray(sessionsRes.data)) {
        setSessions((sessionsRes.data as ImSessionRecord[]).filter(s => s.source === 'im' || s.source === 'http'))
      }
    } catch (err) {
      console.error('[AppExternalChannelsCard] fetch error:', err)
    }
  }, [appId])

  useEffect(() => {
    fetchAll()
    const interval = setInterval(fetchAll, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [fetchAll])

  useEffect(() => {
    const unsub = api.onImSessionUpdated?.((data: unknown) => {
      if ((data as { appId?: string }).appId === appId) fetchAll()
    })
    return () => { unsub?.() }
  }, [appId, fetchAll])

  if (!spaceId) return null

  return (
    <div>
      <h3 className="text-[13px] font-semibold text-foreground mb-2.5">{t('Bound bots')}</h3>
      {instances.length === 0 ? (
        <button
          onClick={() => openAppConfigAt(appId, 'settings-group-notifications')}
          className="w-full flex items-center gap-2 px-3.5 py-3 rounded-lg border border-dashed border-border/60 text-left text-xs text-muted-foreground hover:border-border hover:text-foreground transition-colors"
        >
          <Radio className="w-3.5 h-3.5" />
          {t('No bot bound — configure in Settings')}
        </button>
      ) : (
        <div className="space-y-1.5">
          {instances.map(instance => {
            const instanceSessions = sessions.filter(s => s.instanceId === instance.id)
            const lastActiveAt = instanceSessions.reduce((max, s) => Math.max(max, s.lastActiveAt), 0)
            return (
              <button
                key={instance.id}
                onClick={() => openBotSessions(appId, instance.id)}
                className="w-full flex items-center gap-2.5 px-3.5 py-3 rounded-lg border border-border/60 bg-card text-left transition-all hover:border-border hover:shadow-sm"
              >
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${instance.connected ? 'bg-halo-success' : 'bg-muted-foreground/30'}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-foreground">
                    {CHANNEL_LABELS[instance.type] ?? instance.type}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    {t('{{count}} IM sessions', { count: instanceSessions.length })}
                    {lastActiveAt > 0 && ` · ${formatLastActive(lastActiveAt, t)}`}
                  </div>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
              </button>
            )
          })}
          <button
            onClick={() => openAppConfigAt(appId, 'settings-group-notifications')}
            className="w-full flex items-center gap-2 px-3.5 py-3 rounded-lg border border-dashed border-border/60 text-left text-xs text-muted-foreground hover:border-border hover:text-foreground transition-colors"
          >
            <Radio className="w-3.5 h-3.5" />
            {t('{{count}} bots bound — manage in Settings', { count: instances.length })}
          </button>
        </div>
      )}
    </div>
  )
}
