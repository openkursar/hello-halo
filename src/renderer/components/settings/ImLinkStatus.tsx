/**
 * How an IM bot's connection reads in Settings — one vocabulary for every
 * channel card and section header.
 *
 * A link that is down is almost always being brought back by Halo on its own,
 * so it reads as connecting / reconnecting with the reason, not as a bare
 * "Disconnected" that sends the user hunting for a fault. Only a link Halo has
 * stopped retrying (rejected credentials, an expired session) asks for action.
 */

import { useEffect, useState } from 'react'
import type { TFunction } from 'i18next'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from '../../i18n'
import type {
  ImChannelInstanceStatus,
  ImChannelType,
  ImConnectionState,
} from '../../../shared/types/im-channel'

/** Failed attempts through a proxy before offering to go direct; one may be a blip. */
const SUGGEST_DIRECT_AFTER = 2

export function imConnectionState(status: ImChannelInstanceStatus | undefined): ImConnectionState {
  const state = status?.state ?? (status?.connected ? 'online' : 'offline')
  // The manager reports 'connecting' for an enabled bot that is not running at
  // all (no digital human bound, config incomplete, refused duplicate); only a
  // running link carries link detail, so without it nothing is coming back.
  return state === 'connecting' && !status?.link ? 'offline' : state
}

/** Dot colour and short label for a bot's header line. */
export function imLinkView(
  status: ImChannelInstanceStatus | undefined,
  enabled: boolean,
  t: TFunction,
): { dotClass: string; label: string } {
  if (!enabled) return { dotClass: 'bg-muted-foreground/30', label: t('Disabled') }
  switch (imConnectionState(status)) {
    case 'online':
      return { dotClass: 'bg-green-500', label: t('Connected') }
    case 'standby':
      return { dotClass: 'bg-sky-500', label: t('Standby') }
    case 'reconnecting':
      return { dotClass: 'bg-amber-500', label: t('Reconnecting…') }
    case 'connecting':
      return { dotClass: 'bg-amber-500', label: t('Connecting…') }
    default:
      return status?.link?.lastError
        ? { dotClass: 'bg-red-500', label: t('Stopped') }
        : { dotClass: 'bg-amber-500', label: t('Disconnected') }
  }
}

/** Summary for a channel section header, across that channel's bots. */
export function imSectionSummary(
  statuses: ImChannelInstanceStatus[],
  type: ImChannelType,
  configuredCount: number,
  t: TFunction,
): { dotClass: string; label: string } {
  if (configuredCount === 0) return { dotClass: 'bg-muted-foreground/30', label: t('Not configured') }
  const enabled = statuses.filter((s) => s.type === type && s.enabled)
  if (enabled.length === 0) return { dotClass: 'bg-muted-foreground/30', label: t('Disabled') }
  const states = enabled.map(imConnectionState)
  const online = states.filter((s) => s === 'online').length
  if (online > 0 && online === enabled.length) {
    return { dotClass: 'bg-green-500', label: `${online} ${t('connected')}` }
  }
  if (online > 0) {
    return { dotClass: 'bg-amber-500', label: `${online}/${enabled.length} ${t('connected')}` }
  }
  if (states.includes('standby')) return { dotClass: 'bg-sky-500', label: t('Standby') }
  if (states.includes('reconnecting') || states.includes('connecting')) {
    return { dotClass: 'bg-amber-500', label: t('Reconnecting…') }
  }
  return { dotClass: 'bg-amber-500', label: t('Disconnected') }
}

/** Seconds until `at`, re-rendering once a second while it is in the future. */
function useSecondsUntil(at: number | undefined): number | undefined {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (at === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [at])
  if (at === undefined) return undefined
  return Math.max(0, Math.ceil((at - now) / 1_000))
}

interface ImLinkStatusNoticeProps {
  status: ImChannelInstanceStatus | undefined
  onReconnect?: () => void
  /** Turn message channels off the proxy; offered when the proxy route keeps failing. */
  onUseDirect?: () => void
}

/**
 * The expanded card's status line for a bot that is not up. Renders nothing
 * while online or on standby (those have their own presentation).
 */
export function ImLinkStatusNotice({ status, onReconnect, onUseDirect }: ImLinkStatusNoticeProps) {
  const { t } = useTranslation()
  const state = imConnectionState(status)
  const link = status?.link
  const retryIn = useSecondsUntil(state === 'online' || state === 'standby' ? undefined : link?.nextRetryAt)
  if (state === 'online' || state === 'standby') return null

  const offline = state === 'offline'
  // Halo gave up on this link (rejected credentials, expired session).
  const halted = offline && Boolean(link?.lastError)
  const reason = link?.lastError ?? status?.reason
  const title = halted
    ? t('Stopped — Halo will not retry until you reconnect')
    : offline
      ? t('Disconnected')
      : state === 'reconnecting'
        ? t('Reconnecting')
        : t('Connecting')
  const attempt = !offline && link && link.attempt > 0
    ? retryIn !== undefined
      ? t('Attempt {{n}} failed, retrying in {{s}} s', { n: link.attempt, s: retryIn })
      : t('Attempt {{n}} failed, retrying', { n: link.attempt })
    : undefined
  const suggestDirect = !offline && onUseDirect && link?.viaProxy && link.attempt >= SUGGEST_DIRECT_AFTER
  // Without a running link (e.g. a refused duplicate bot) there is nothing to reconnect.
  const canReconnect = onReconnect && link !== undefined

  return (
    <div
      className={`space-y-1.5 rounded-lg px-3 py-2 ${
        halted ? 'bg-red-500/10 border border-red-500/30' : 'bg-amber-500/10'
      }`}
    >
      <div
        className={`flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs ${
          halted ? 'text-red-500' : 'text-amber-600 theme-dark:text-amber-500'
        }`}
      >
        <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${halted ? 'bg-red-500' : 'bg-amber-500'}`} />
        <span className="font-medium">{title}</span>
        {attempt && <span className="text-muted-foreground">· {attempt}</span>}
      </div>
      {reason && <p className="text-xs text-muted-foreground break-words">{reason}</p>}
      {suggestDirect && (
        <p className="text-xs text-muted-foreground">
          {t('The connection goes through your proxy and keeps failing. If that proxy is only meant for AI requests, message channels can connect directly instead.')}
        </p>
      )}
      {(canReconnect || suggestDirect) && (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          {canReconnect && (
            <button
              type="button"
              onClick={onReconnect}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              {t('Reconnect now')}
            </button>
          )}
          {suggestDirect && (
            <button
              type="button"
              onClick={onUseDirect}
              className="px-2.5 py-1 text-xs rounded-md border border-border text-foreground hover:bg-muted transition-colors"
            >
              {t('Connect directly')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
