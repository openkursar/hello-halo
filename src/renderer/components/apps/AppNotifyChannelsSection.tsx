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
  ExternalLink, Users, User, Pencil, Trash2, Copy, Check,
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

// ============================================
// Types
// ============================================

interface AppNotifyChannelsSectionProps {
  appId: string
  /** App name for display */
  appName?: string
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
  const { setView } = useAppStore()
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
    setView('settings')
    setTimeout(() => {
      const el = document.getElementById('message-channels')
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 100)
  }, [setView])

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
  const [loading, setLoading] = useState(true)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  const fetchSessions = useCallback(async () => {
    try {
      const result = await api.imSessionsList(appId) as { success: boolean; data?: ImSessionRecord[] }
      if (result.success && result.data) {
        // Only IM sessions are pushable; HTTP sessions have no channel adapter.
        setSessions(result.data.filter(s => s.source === 'im'))
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
    setEditingName(session.customName ?? session.displayName)
    setTimeout(() => renameInputRef.current?.focus(), 0)
  }, [])

  const handleCommitRename = useCallback(async (session: ImSessionRecord) => {
    const trimmed = editingName.trim()
    setEditingKey(null)
    if (!trimmed || trimmed === (session.customName ?? session.displayName)) return

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
    const displayName = session.customName ?? session.displayName
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

  if (loading) {
    return (
      <div className="text-sm text-muted-foreground py-3 text-center">
        {t('Loading...')}
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-4 text-center space-y-1">
        <MessageSquare className="w-5 h-5 mx-auto mb-1 opacity-30" />
        <p>{t('No contacts yet')}</p>
        <p className="text-xs">{t('Contacts appear automatically when someone messages via Bot')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      {sessions.map((session) => {
        const channelInfo = getImChannelDisplay(session.channel)
        const key = `${session.appId}:${session.channel}:${session.chatId}`
        const displayName = session.customName ?? session.displayName
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
  )
}

// ============================================
// Main Component
// ============================================

export function AppNotifyChannelsSection({ appId, appName, imPushEnabled }: AppNotifyChannelsSectionProps) {
  const { t } = useTranslation()

  return (
    <div className="space-y-4">
      {/* A. Notification Channel Overview */}
      <ChannelOverview />

      {/* B. Reachable Contacts (only when im-push enabled) */}
      {imPushEnabled && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">{t('Reachable Contacts')}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('Toggle auto-sync to push the AI final reply to a contact after each run. The AI may also message any contact proactively when your prompt instructs it.')}
          </p>
          <ContactsSection appId={appId} />
        </div>
      )}
    </div>
  )
}
