/**
 * ImNameResolutionBanner
 *
 * WeCom anonymizes message senders for a bot unless the bot's owner
 * authorizes the "Message" capability in the WeCom client; until then,
 * contacts show a raw id instead of their real name. This nudges the user to
 * turn that on.
 *
 * Spans the full width above AppBotSessionsView's two panes rather than
 * living inside the narrow contact list — it is guidance about the bot as a
 * whole, not about any one row in that list.
 */

import { useState, useEffect, useCallback } from 'react'
import { AlertTriangle, Info, ExternalLink, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import type { ImSessionRecord, ImChannelInstanceStatus } from '../../../shared/types/im-channel'

/**
 * WeCom's own documentation for the "message" permission capability — the
 * exact page explaining how to authorize it and copy the URL this feature
 * needs. Not a Halo-authored guide (this feature has none yet), but the
 * authoritative source for the steps involved.
 */
const IM_NAME_RESOLUTION_DOC_URL = 'https://developer.work.weixin.qq.com/document/path/101764'

/** LocalStorage-backed dismiss flag. Permanent until localStorage is cleared — matches "not a required setup step, don't keep asking". */
function useDismissedFlag(key: string): [boolean, () => void] {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(key) === '1'
    } catch {
      return false
    }
  })
  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(key, '1')
    } catch {
      // Ignore — worst case the banner reappears next session
    }
    setDismissed(true)
  }, [key])
  return [dismissed, dismiss]
}

interface ImNameResolutionBannerProps {
  appId: string
  instanceId: string
}

export function ImNameResolutionBanner({ appId, instanceId }: ImNameResolutionBannerProps) {
  const { t } = useTranslation()
  const [sessions, setSessions] = useState<ImSessionRecord[]>([])
  const [instanceStatuses, setInstanceStatuses] = useState<ImChannelInstanceStatus[]>([])

  const [dismissedUnconfigured, dismissUnconfigured] = useDismissedFlag('halo.imNameResolution.dismissed.unconfigured')
  const [dismissedExpired, dismissExpired] = useDismissedFlag('halo.imNameResolution.dismissed.expired')

  useEffect(() => {
    let cancelled = false
    Promise.all([
      api.imSessionsList(appId) as Promise<{ success: boolean; data?: ImSessionRecord[] }>,
      api.imChannelsStatus() as Promise<{ success: boolean; data?: ImChannelInstanceStatus[] }>,
    ]).then(([sessionsRes, statusRes]) => {
      if (cancelled) return
      if (sessionsRes.success && sessionsRes.data) {
        setSessions(sessionsRes.data.filter(s => s.source === 'im' && s.instanceId === instanceId))
      }
      if (statusRes.success && statusRes.data) setInstanceStatuses(statusRes.data)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [appId, instanceId])

  // Only for WeCom direct-message contacts still showing their raw
  // (unresolved) id. 'Expired' takes priority over 'not yet configured' — it
  // means the feature was working and regressed, which deserves fresh
  // attention even if the user already dismissed the initial nudge.
  const wecomSessions = sessions.filter(s => s.channel === 'wecom-bot' && s.chatType === 'direct')
  const hasUnresolvedWecomContact = wecomSessions.some(
    s => !s.customName && !s.resolvedName && s.displayName === s.chatId
  )
  const status = instanceStatuses.find(st => st.id === instanceId)
  const showExpiredBanner = hasUnresolvedWecomContact && status?.identityResolution?.status === 'expired' && !dismissedExpired
  const showUnconfiguredBanner =
    hasUnresolvedWecomContact && !status?.identityResolution && !showExpiredBanner && !dismissedUnconfigured

  if (showExpiredBanner) {
    return (
      <div className="flex items-start gap-2 px-4 sm:px-10 py-2.5 bg-amber-500/10 border-b border-amber-500/30">
        <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0 flex items-center flex-wrap gap-x-3 gap-y-1">
          <p className="text-xs text-foreground/80">
            {t('Name resolution authorization expired (valid 7 days). New contacts will show raw IDs until you re-authorize in the WeCom client.')}
          </p>
          <button
            type="button"
            onClick={() => { void api.openExternal(IM_NAME_RESOLUTION_DOC_URL) }}
            className="text-xs text-primary hover:underline inline-flex items-center gap-1 flex-shrink-0"
          >
            {t('How to re-authorize')}
            <ExternalLink className="w-3 h-3" />
          </button>
        </div>
        <button
          type="button"
          onClick={dismissExpired}
          title={t('Dismiss')}
          className="p-0.5 text-muted-foreground hover:text-foreground transition-colors rounded flex-shrink-0"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    )
  }

  if (showUnconfiguredBanner) {
    return (
      <div className="flex items-start gap-2 px-4 sm:px-10 py-2.5 bg-primary/5 border-b border-primary/20">
        <Info className="w-4 h-4 text-primary shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0 flex items-center flex-wrap gap-x-3 gap-y-1">
          <p className="text-xs text-foreground/80">
            {t('Contacts show raw IDs because WeCom anonymizes senders for this bot. Authorize the "Message" capability in the WeCom client to show real names automatically — optional, but recommended.')}
          </p>
          <button
            type="button"
            onClick={() => { void api.openExternal(IM_NAME_RESOLUTION_DOC_URL) }}
            className="text-xs text-primary hover:underline inline-flex items-center gap-1 flex-shrink-0"
          >
            {t('Learn how')}
            <ExternalLink className="w-3 h-3" />
          </button>
        </div>
        <button
          type="button"
          onClick={dismissUnconfigured}
          title={t('Dismiss')}
          className="p-0.5 text-muted-foreground hover:text-foreground transition-colors rounded flex-shrink-0"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    )
  }

  return null
}
