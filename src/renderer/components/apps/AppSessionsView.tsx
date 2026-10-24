/**
 * AppSessionsView
 *
 * The "IM / Remote" tab of a digital human: conversations other people and
 * systems hold with it — over its bound IM bots (customers talking to the bot)
 * and over Halo's HTTP API (remote calls) — as opposed to the owner's own
 * conversations, which live on the main board.
 *
 * Each bound bot is a group, and the remote calls are one more. One group —
 * straight into it. Several — a chip row picks the group first. None — a
 * pointer to Settings, where binding lives; the tab itself only appears once
 * there is a group, so this state is reached mainly after an unbind.
 */

import { useState } from 'react'
import { Loader2, Radio } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useAppImInstances } from '../../hooks/useAppImInstances'
import { useAppHttpSessions } from '../../hooks/useAppHttpSessions'
import { AppBotSessionsView } from './AppBotSessionsView'
import { AppHttpSessionsView } from './AppHttpSessionsView'
import { getImBotLabel } from './im-channel-labels'

/** The remote calls' group id; bot instance ids are UUIDs, so it never names a bot. */
const REMOTE_CALLS = 'remote-calls'

export function AppSessionsView({ appId, spaceId }: { appId: string; spaceId: string | null }) {
  const { t } = useTranslation()
  const openAppConfigAt = useAppsPageStore(s => s.openAppConfigAt)
  const { instances, loading } = useAppImInstances(appId)
  const { sessions: httpSessions, loading: httpLoading } = useAppHttpSessions(appId)
  const [pickedId, setPickedId] = useState<string | null>(null)

  const groupIds = [...instances.map(instance => instance.id), ...(httpSessions.length > 0 ? [REMOTE_CALLS] : [])]
  // A pick whose group went away (a bot unbound while this tab is open) falls
  // back to the first group.
  const selectedId = pickedId !== null && groupIds.includes(pickedId) ? pickedId : groupIds[0] ?? null

  // Choose the first group only once the bot list is known: remote calls read
  // sooner would otherwise show, then give way to the first bot.
  if ((loading && instances.length === 0) || (httpLoading && groupIds.length === 0)) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
  }

  if (groupIds.length === 0 || !spaceId) {
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

  const chipClass = (id: string) => `flex flex-shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors ${
    selectedId === id
      ? 'border-border bg-secondary text-foreground'
      : 'border-border-faint text-muted-foreground hover:text-foreground hover:bg-secondary/50'
  }`

  return (
    <div className="flex h-full min-h-0 flex-col">
      {groupIds.length > 1 && (
        <div className="flex flex-shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border-faint px-3 py-2 sm:px-4">
          {instances.map(instance => (
            <button
              key={instance.id}
              onClick={() => setPickedId(instance.id)}
              aria-pressed={selectedId === instance.id}
              className={chipClass(instance.id)}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${instance.connected ? 'bg-halo-success' : 'bg-muted-foreground/30'}`} />
              {getImBotLabel(instance, t)}
            </button>
          ))}
          {httpSessions.length > 0 && (
            <button
              onClick={() => setPickedId(REMOTE_CALLS)}
              aria-pressed={selectedId === REMOTE_CALLS}
              className={chipClass(REMOTE_CALLS)}
            >
              {t('Remote calls')}
              <span className="text-muted-foreground">{httpSessions.length}</span>
            </button>
          )}
        </div>
      )}
      {selectedId === REMOTE_CALLS ? (
        <div className="min-h-0 flex-1">
          {/* Keyed per digital human: switching people keeps this tab, not the call picked on it. */}
          <AppHttpSessionsView key={appId} appId={appId} spaceId={spaceId} sessions={httpSessions} />
        </div>
      ) : selectedId && (
        <div className="min-h-0 flex-1">
          <AppBotSessionsView key={selectedId} appId={appId} spaceId={spaceId} instanceId={selectedId} />
        </div>
      )}
    </div>
  )
}
