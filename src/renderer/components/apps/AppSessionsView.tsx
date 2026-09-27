/**
 * AppSessionsView
 *
 * The "IM sessions" tab of a digital human: conversations people have
 * with it over its bound IM/HTTP channels (customers talking to the bot), as
 * opposed to the owner's own conversation, which lives on the main board.
 *
 * One bot bound — straight into that bot's session browser. Several — a chip
 * row picks the instance first. None — a pointer to Settings, where binding
 * lives; the tab itself only appears once a bot is bound, so this state is
 * reached mainly after an unbind.
 */

import { useEffect, useState } from 'react'
import { Loader2, Radio } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useAppImInstances } from '../../hooks/useAppImInstances'
import { AppBotSessionsView } from './AppBotSessionsView'
import { CHANNEL_LABELS } from './im-channel-labels'

export function AppSessionsView({ appId, spaceId }: { appId: string; spaceId: string | null }) {
  const { t } = useTranslation()
  const openAppConfigAt = useAppsPageStore(s => s.openAppConfigAt)
  const { instances, loading } = useAppImInstances(appId)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Follow the instance list: adopt the first instance, and drop a selection
  // whose instance was unbound while this tab was open.
  useEffect(() => {
    setSelectedId(current => instances.some(instance => instance.id === current) ? current : instances[0]?.id ?? null)
  }, [instances])

  if (loading && instances.length === 0) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
  }

  if (instances.length === 0 || !spaceId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-secondary"><Radio className="h-6 w-6 text-muted-foreground" /></div>
        <div>
          <p className="text-sm font-medium text-foreground">{t('No bot bound yet')}</p>
          <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">{t('Bind an IM bot so people can reach this digital human, then their conversations appear here.')}</p>
        </div>
        <button
          onClick={() => openAppConfigAt(appId, 'settings-group-notifications')}
          className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          {t('Bind a bot in Settings')}
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {instances.length > 1 && (
        <div className="flex flex-shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border px-3 py-2 sm:px-4">
          {instances.map(instance => (
            <button
              key={instance.id}
              onClick={() => setSelectedId(instance.id)}
              aria-pressed={selectedId === instance.id}
              className={`flex flex-shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors ${
                selectedId === instance.id
                  ? 'border-primary/50 bg-primary/10 text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground hover:bg-secondary/50'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${instance.connected ? 'bg-halo-success' : 'bg-muted-foreground/30'}`} />
              {CHANNEL_LABELS[instance.type] ?? instance.type}
            </button>
          ))}
        </div>
      )}
      {selectedId && (
        <div className="min-h-0 flex-1">
          <AppBotSessionsView key={selectedId} appId={appId} spaceId={spaceId} instanceId={selectedId} />
        </div>
      )}
    </div>
  )
}
