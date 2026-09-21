/**
 * AppNotifyChannelsSection (通知能力概览 + 联系人管理)
 *
 * Two subsections:
 *
 * A. Notification Channel Overview (read-only)
 *    Shows which external channels are configured, with status indicators.
 *    No toggle — external channel notifications are now AI-driven.
 *    Links to Settings for configuration.
 *
 * B. Reachable Contacts (when im-push enabled)
 *    Shows IM sessions for this app with editable display names and a
 *    per-contact "Auto-sync run result" toggle.
 *    - The toggle (proactive flag) controls whether the system pushes the
 *      assistant's final text to that contact at run completion.
 *    - These contacts also appear in the AI's notify_bot tool directory
 *      for mid-run AI-driven notifications.
 *    Contacts are auto-discovered when users message via Bot.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Mail, MessageSquare, Bell, Webhook,
  ExternalLink, Users, User, Pencil, Trash2, Copy, Check, Search,
  AlertTriangle, Info,
} from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useAppStore } from '../../stores/app.store'
import { api } from '../../api'
import type { HaloConfig } from '../../types'
import type {
  NotificationChannelsConfig,
} from '../../../shared/types/notification-channels'
import { NOTIFICATION_CHANNEL_META } from '../../../shared/types/notification-channels'
import type { ImSessionRecord, ImChannelInstanceStatus } from '../../../shared/types/im-channel'
import { getImSessionDisplayName } from '../../../shared/types/im-channel'

// ============================================
// Types
// ============================================

interface AppNotifyChannelsSectionProps {
  appId: string
  /** Whether im-push permission is enabled for this app */
  imPushEnabled: boolean
}

// ============================================
// Channel Display Config
// ============================================

interface ChannelDisplayInfo {
  id: string
  icon: typeof Mail
  labelKey: string
}

const NOTIFICATION_CHANNELS: ChannelDisplayInfo[] = [
  { id: 'email', icon: Mail, labelKey: NOTIFICATION_CHANNEL_META.email.labelKey },
  { id: 'wecom', icon: MessageSquare, labelKey: NOTIFICATION_CHANNEL_META.wecom.labelKey },
  { id: 'dingtalk', icon: Bell, labelKey: NOTIFICATION_CHANNEL_META.dingtalk.labelKey },
  { id: 'feishu', icon: MessageSquare, labelKey: NOTIFICATION_CHANNEL_META.feishu.labelKey },
  { id: 'webhook', icon: Webhook, labelKey: NOTIFICATION_CHANNEL_META.webhook.labelKey },
]

const IM_CHANNEL_DISPLAY: Record<string, { label: string; color: string }> = {
  'wecom-bot': { label: 'WeCom', color: 'text-green-500' },
  'feishu-bot': { label: 'Feishu', color: 'text-blue-500' },
  'dingtalk-bot': { label: 'DingTalk', color: 'text-indigo-500' },
  'weixin-ilink-bot': { label: 'WeChat iLink', color: 'text-green-600' },
}

function getImChannelDisplay(channel: string) {
  return IM_CHANNEL_DISPLAY[channel] ?? { label: channel, color: 'text-muted-foreground' }
}

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

function formatTime(ts: number): string {
  if (!ts) return '-'
  const d = new Date(ts)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }
  if (diffDays === 1) return '1d ago'
  if (diffDays < 30) return `${diffDays}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// ============================================
// Channel Overview (read-only)
// ============================================

function ChannelOverview() {
  const { t } = useTranslation()
  const { navigate } = useAppStore()
  const [config, setConfig] = useState<HaloConfig | null>(null)

  useEffect(() => {
    let cancelled = false
    api.getConfig().then((res: any) => {
      if (!cancelled && res.success && res.data) setConfig(res.data)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  const channels = config?.notificationChannels as NotificationChannelsConfig | undefined

  const handleGoToSettings = useCallback(() => {
    navigate('settings')
    setTimeout(() => {
      const el = document.getElementById('message-channels')
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 100)
  }, [navigate])

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {t('AI-driven: the digital human decides when and what to notify via configured channels.')}
      </p>
      <div className="space-y-1">
        {NOTIFICATION_CHANNELS.map((ch) => {
          const Icon = ch.icon
          const channelConfig = channels?.[ch.id as keyof NotificationChannelsConfig] as { enabled?: boolean } | undefined
          const configured = Boolean(channelConfig?.enabled)

          return (
            <div
              key={ch.id}
              className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md"
            >
              <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${configured ? 'bg-green-500' : 'bg-muted-foreground/30'}`} />
              <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${configured ? 'text-muted-foreground' : 'text-muted-foreground/40'}`} />
              <span className={`text-sm flex-1 ${configured ? 'text-foreground' : 'text-muted-foreground/60'}`}>
                {t(ch.labelKey)}
              </span>
              <span className={`text-xs ${configured ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground/50'}`}>
                {configured ? t('Configured') : t('Not configured')}
              </span>
            </div>
          )
        })}
      </div>
      <button
        type="button"
        onClick={handleGoToSettings}
        className="text-xs text-primary hover:text-primary/80 transition-colors flex items-center gap-1"
      >
        {t('Configure channels in Settings')}
        <ExternalLink className="w-3 h-3" />
      </button>
    </div>
  )
}

// ============================================
// Contacts Section (when im-push enabled)
// ============================================

function ContactsSection({ appId }: { appId: string }) {
  const { t } = useTranslation()
  const [sessions, setSessions] = useState<ImSessionRecord[]>([])
  const [instanceStatuses, setInstanceStatuses] = useState<ImChannelInstanceStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  // Dismiss flags for the name-resolution guidance banner. Declared
  // unconditionally here (not after the loading/empty early returns below)
  // per the rules of hooks.
  const [dismissedUnconfigured, dismissUnconfigured] = useDismissedFlag('halo.imNameResolution.dismissed.unconfigured')
  const [dismissedExpired, dismissExpired] = useDismissedFlag('halo.imNameResolution.dismissed.expired')

  /** Above this count, surface a search box and keep the list height-bounded. */
  const SEARCH_THRESHOLD = 8

  const fetchSessions = useCallback(async () => {
    try {
      const [sessionsRes, statusRes] = await Promise.all([
        api.imSessionsList(appId) as Promise<{ success: boolean; data?: ImSessionRecord[] }>,
        api.imChannelsStatus() as Promise<{ success: boolean; data?: ImChannelInstanceStatus[] }>,
      ])
      if (sessionsRes.success && sessionsRes.data) {
        // Only IM sessions are pushable; HTTP sessions have no channel adapter.
        setSessions(sessionsRes.data.filter(s => s.source === 'im'))
      }
      if (statusRes.success && statusRes.data) {
        setInstanceStatuses(statusRes.data)
      }
    } catch {
      // Ignore
    } finally {
      setLoading(false)
    }
  }, [appId])

  useEffect(() => {
    fetchSessions()
    const interval = setInterval(fetchSessions, 15_000)
    return () => clearInterval(interval)
  }, [fetchSessions])

  // Name-resolution guidance banner: only for WeCom direct-message contacts
  // that are still showing their raw (unresolved) id. 'Expired' takes
  // priority over 'not yet configured' — it means the feature was working
  // and regressed, which deserves fresh attention even if the user already
  // dismissed the initial "did you know" nudge.
  const wecomSessions = sessions.filter(s => s.channel === 'wecom-bot' && s.chatType === 'direct')
  const hasUnresolvedWecomContact = wecomSessions.some(
    s => !s.customName && !s.resolvedName && s.displayName === s.chatId
  )
  const wecomInstanceIds = new Set(wecomSessions.map(s => s.instanceId))
  const wecomInstanceStatuses = instanceStatuses.filter(st => wecomInstanceIds.has(st.id))
  const anyIdentityConfigured = wecomInstanceStatuses.some(st => st.identityResolution)
  const anyIdentityExpired = wecomInstanceStatuses.some(st => st.identityResolution?.status === 'expired')
  const showExpiredBanner = hasUnresolvedWecomContact && anyIdentityExpired && !dismissedExpired
  const showUnconfiguredBanner =
    hasUnresolvedWecomContact && !anyIdentityConfigured && !showExpiredBanner && !dismissedUnconfigured

  const nameResolutionBanner = showExpiredBanner ? (
    <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2">
      <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0 space-y-1">
        <p className="text-xs text-foreground/80">
          {t('Name resolution authorization expired (valid 7 days). New contacts will show raw IDs until you re-authorize in the WeCom client.')}
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => { void api.openExternal(IM_NAME_RESOLUTION_DOC_URL) }}
            className="text-xs text-primary hover:underline inline-flex items-center gap-1"
          >
            {t('How to re-authorize')}
            <ExternalLink className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={dismissExpired}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('Dismiss')}
          </button>
        </div>
      </div>
    </div>
  ) : showUnconfiguredBanner ? (
    <div className="flex items-start gap-2 rounded-lg bg-primary/10 border border-primary/30 px-3 py-2">
      <Info className="w-4 h-4 text-primary shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0 space-y-1">
        <p className="text-xs text-foreground/80">
          {t('Contacts show raw IDs because WeCom anonymizes senders for this bot. Authorize the "Message" capability in the WeCom client to show real names automatically — optional, but recommended.')}
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => { void api.openExternal(IM_NAME_RESOLUTION_DOC_URL) }}
            className="text-xs text-primary hover:underline inline-flex items-center gap-1"
          >
            {t('Learn how')}
            <ExternalLink className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={dismissUnconfigured}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('Dismiss')}
          </button>
        </div>
      </div>
    </div>
  ) : null

  const handleRemove = useCallback(async (session: ImSessionRecord) => {
    try {
      const result = await api.imSessionsRemove({
        appId: session.appId,
        channel: session.channel,
        chatId: session.chatId,
      })
      if (result.success) {
        setSessions(prev =>
          prev.filter(s => !(s.appId === session.appId && s.channel === session.channel && s.chatId === session.chatId))
        )
      }
    } catch {
      // Ignore
    }
  }, [])

  const handleStartRename = useCallback((session: ImSessionRecord) => {
    const key = `${session.appId}:${session.channel}:${session.chatId}`
    setEditingKey(key)
    setEditingName(getImSessionDisplayName(session))
    setTimeout(() => renameInputRef.current?.focus(), 0)
  }, [])

  const handleCommitRename = useCallback(async (session: ImSessionRecord) => {
    const trimmed = editingName.trim()
    setEditingKey(null)
    if (!trimmed || trimmed === getImSessionDisplayName(session)) return

    try {
      const result = await api.imSessionsSetCustomName({
        appId: session.appId,
        channel: session.channel,
        chatId: session.chatId,
        name: trimmed,
      })
      if (result.success) {
        setSessions(prev =>
          prev.map(s =>
            s.appId === session.appId && s.channel === session.channel && s.chatId === session.chatId
              ? { ...s, customName: trimmed }
              : s
          )
        )
      }
    } catch {
      // Ignore
    }
  }, [editingName])

  const handleToggleProactive = useCallback(async (session: ImSessionRecord, next: boolean) => {
    // Optimistic update: flip immediately, revert on failure. The IPC round-
    // trip is fast on desktop but noticeable on remote — optimistic UI keeps
    // the toggle feeling responsive regardless of transport.
    setSessions(prev =>
      prev.map(s =>
        s.appId === session.appId && s.channel === session.channel && s.chatId === session.chatId
          ? { ...s, proactive: next }
          : s
      )
    )
    try {
      const result = await api.imSessionsSetProactive({
        appId: session.appId,
        channel: session.channel,
        chatId: session.chatId,
        proactive: next,
      })
      if (!result.success) {
        // Revert on backend rejection
        setSessions(prev =>
          prev.map(s =>
            s.appId === session.appId && s.channel === session.channel && s.chatId === session.chatId
              ? { ...s, proactive: !next }
              : s
          )
        )
      }
    } catch {
      setSessions(prev =>
        prev.map(s =>
          s.appId === session.appId && s.channel === session.channel && s.chatId === session.chatId
            ? { ...s, proactive: !next }
            : s
        )
      )
    }
  }, [])

  const handleCopyContact = useCallback(async (session: ImSessionRecord) => {
    const displayName = getImSessionDisplayName(session)
    const text = `Name: ${displayName} ID: ${session.instanceId}:${session.chatId}`
    try {
      await navigator.clipboard.writeText(text)
      const key = `${session.appId}:${session.channel}:${session.chatId}`
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(null), 2000)
    } catch {
      // Ignore
    }
  }, [])

  // Contact header (icon + label + live count) — owned here so the count stays
  // in sync with the fetched sessions without threading state up to the parent.
  const header = (
    <div className="flex items-center gap-1.5">
      <Users className="w-3.5 h-3.5 text-muted-foreground" />
      <span className="text-sm font-medium text-foreground">{t('Reachable Contacts')}</span>
      {sessions.length > 0 && (
        <span className="text-xs text-muted-foreground/60">({sessions.length})</span>
      )}
    </div>
  )

  const hint = (
    <p className="text-xs text-muted-foreground">
      {t('Toggle auto-sync to push the AI final reply to a contact after each run. The AI may also message any contact proactively when your prompt instructs it.')}
    </p>
  )

  if (loading) {
    return (
      <div className="space-y-2">
        {header}
        <div className="text-sm text-muted-foreground py-3 text-center">
          {t('Loading...')}
        </div>
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div className="space-y-2">
        {header}
        {hint}
        <div className="text-sm text-muted-foreground py-4 text-center space-y-1">
          <MessageSquare className="w-5 h-5 mx-auto mb-1 opacity-30" />
          <p>{t('No contacts yet')}</p>
          <p className="text-xs">{t('Contacts appear automatically when someone messages via Bot')}</p>
        </div>
      </div>
    )
  }

  const q = query.trim().toLowerCase()
  const filtered = q
    ? sessions.filter((s) => {
        const name = getImSessionDisplayName(s).toLowerCase()
        return name.includes(q) || s.chatId.toLowerCase().includes(q)
      })
    : sessions

  return (
    <div className="space-y-2">
      {header}
      {nameResolutionBanner}
      {hint}

      {/* Search — only when the list is long enough to warrant filtering */}
      {sessions.length > SEARCH_THRESHOLD && (
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/60 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('Search contacts')}
            className="w-full pl-8 pr-3 py-1.5 text-sm bg-secondary border border-border rounded-lg outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground/50"
          />
        </div>
      )}

      {/* Height-bounded scroll region so a large contact list never pushes the
          rest of the settings page far down. */}
      <div className="space-y-1.5 max-h-[320px] overflow-y-auto -mr-1 pr-1">
        {filtered.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-3">
            {t('No contacts match "{{query}}"', { query })}
          </p>
        )}
        {filtered.map((session) => {
        const channelInfo = getImChannelDisplay(session.channel)
        const key = `${session.appId}:${session.channel}:${session.chatId}`
        const displayName = getImSessionDisplayName(session)
        const proactiveOn = session.proactive === true

        return (
          <div
            key={key}
            className="flex flex-col gap-2 p-2.5 rounded-lg bg-muted/50 hover:bg-muted/70 transition-colors group/contact"
          >
            <div className="flex items-center gap-2.5">
              {/* Chat type icon */}
              {session.chatType === 'group' ? (
                <Users className="w-4 h-4 text-muted-foreground shrink-0" />
              ) : (
                <User className="w-4 h-4 text-muted-foreground shrink-0" />
              )}

              {/* Contact info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  {editingKey === key ? (
                    <input
                      ref={renameInputRef}
                      type="text"
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onBlur={() => handleCommitRename(session)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleCommitRename(session)
                        if (e.key === 'Escape') setEditingKey(null)
                      }}
                      className="text-sm font-medium bg-background border border-border rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-primary w-full max-w-[200px]"
                    />
                  ) : (
                    <>
                      <span className="text-sm font-medium truncate">
                        {displayName}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleStartRename(session)}
                        className="p-0.5 text-muted-foreground hover:text-foreground transition-colors rounded opacity-0 group-hover/contact:opacity-100"
                        title={t('Rename')}
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                    </>
                  )}
                  <span className={`text-xs shrink-0 ${channelInfo.color}`}>
                    {channelInfo.label}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground/60 mt-0.5 flex flex-wrap items-center gap-x-1">
                  <span>{session.chatType === 'group' ? t('Group') : t('Direct')}</span>
                  <span>·</span>
                  <span className="font-mono text-[10px] break-all">{session.chatId}</span>
                  <span>·</span>
                  <span>{formatTime(session.lastActiveAt)}</span>
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => handleCopyContact(session)}
                  className="p-1 text-muted-foreground hover:text-foreground transition-colors rounded opacity-0 group-hover/contact:opacity-100"
                  title={t('Copy contact info')}
                >
                  {copiedKey === key
                    ? <Check className="w-3.5 h-3.5 text-green-500" />
                    : <Copy className="w-3.5 h-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => handleRemove(session)}
                  className="p-1 text-muted-foreground hover:text-red-500 transition-colors rounded opacity-0 group-hover/contact:opacity-100"
                  title={t('Remove')}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Auto-sync toggle: pushes the AI final reply to this contact at run end */}
            <label className="flex items-start gap-2 pl-6 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={proactiveOn}
                onChange={(e) => handleToggleProactive(session, e.target.checked)}
                className="mt-0.5 w-3.5 h-3.5 rounded border-border accent-primary cursor-pointer"
              />
              <span className="flex-1 min-w-0">
                <span className="text-xs text-foreground">
                  {t('Auto-sync run result')}
                </span>
                <span className="block text-xs text-muted-foreground/70 mt-0.5">
                  {t('Send the AI final reply to this contact after each successful run')}
                </span>
              </span>
            </label>
          </div>
        )
        })}
      </div>
    </div>
  )
}

// ============================================
// Main Component
// ============================================

export function AppNotifyChannelsSection({ appId, imPushEnabled }: AppNotifyChannelsSectionProps) {
  return (
    <div className="space-y-4">
      {/* A. Notification Channel Overview */}
      <ChannelOverview />

      {/* B. Reachable Contacts (only when im-push enabled) */}
      {imPushEnabled && <ContactsSection appId={appId} />}
    </div>
  )
}
