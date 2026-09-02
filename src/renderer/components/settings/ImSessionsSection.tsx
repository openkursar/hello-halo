/**
 * IM Sessions Section Component (IM 会话管理)
 *
 * Displays known IM sessions with session management capabilities:
 * - View session details (chat type, channel, last active)
 * - Edit custom display names (used by AI for natural language matching)
 * - Remove stale sessions
 *
 * Per-contact auto-sync toggle lives on the digital human detail page
 * (AppNotifyChannelsSection). This global settings view stays read-write
 * for naming and removal only — the toggle would be ambiguous when the
 * view aggregates sessions across all apps.
 *
 * Two modes:
 * - With appId: shows sessions for a specific digital human
 * - Without appId: shows ALL sessions across all apps (for global settings page)
 *
 * Channel-agnostic: renders channel icon/name from the channel field,
 * adding a new channel only requires a mapping entry.
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { MessageSquare, Radio, Users, User, Trash2, Pencil, Copy, Check } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import type { ImSessionRecord } from '../../../shared/types/im-channel'
import { getImSessionDisplayName } from '../../../shared/types/im-channel'

// ============================================
// Types
// ============================================

interface ImSessionsSectionProps {
  /** If provided, only show sessions for this app. Otherwise show all. */
  appId?: string
  appName?: string
  /** When true, render without the section wrapper/title — for embedding inside other components */
  compact?: boolean
}

// ============================================
// Channel Display Config
// ============================================

const CHANNEL_DISPLAY: Record<string, { label: string; color: string }> = {
  'wecom-bot': { label: 'WeCom', color: 'text-green-500' },
  'feishu-bot': { label: 'Feishu', color: 'text-blue-500' },
  'dingtalk-bot': { label: 'DingTalk', color: 'text-indigo-500' },
  'weixin-ilink-bot': { label: 'WeChat iLink', color: 'text-green-600' },
}

function getChannelDisplay(channel: string) {
  return CHANNEL_DISPLAY[channel] ?? { label: channel, color: 'text-muted-foreground' }
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
// Component
// ============================================

export function ImSessionsSection({ appId, appName, compact }: ImSessionsSectionProps) {
  const { t } = useTranslation()
  const [sessions, setSessions] = useState<ImSessionRecord[]>([])
  const [appNames, setAppNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  const isGlobalMode = !appId

  const fetchSessions = useCallback(async () => {
    try {
      const result = await api.imSessionsList(appId) as { success: boolean; data?: ImSessionRecord[] }
      if (result.success && result.data) {
        setSessions(result.data)

        // In global mode, fetch app names for display
        if (isGlobalMode && result.data.length > 0) {
          const uniqueAppIds = [...new Set(result.data.map(s => s.appId))]
          const names: Record<string, string> = {}
          await Promise.all(
            uniqueAppIds.map(async (id) => {
              try {
                const appResult = await api.appGet(id) as { success: boolean; data?: { spec?: { name?: string } } }
                if (appResult.success && appResult.data?.spec?.name) {
                  names[id] = appResult.data.spec.name
                }
              } catch {
                // Ignore — will fall back to appId
              }
            })
          )
          setAppNames(names)
        }
      }
    } catch {
      // Ignore errors
    } finally {
      setLoading(false)
    }
  }, [appId, isGlobalMode])

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
      // Ignore errors
    }
  }, [])

  const handleStartRename = useCallback((session: ImSessionRecord) => {
    const key = `${session.appId}:${session.channel}:${session.chatId}`
    setEditingKey(key)
    setEditingName(getImSessionDisplayName(session))
    // Focus input on next tick after render
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
      // Ignore errors
    }
  }, [editingName])

  const handleCopyContact = useCallback(async (session: ImSessionRecord) => {
    const displayName = getImSessionDisplayName(session)
    const text = `Name: ${displayName} ID: ${session.instanceId}:${session.chatId}`
    try {
      await navigator.clipboard.writeText(text)
      const key = `${session.appId}:${session.channel}:${session.chatId}`
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(null), 2000)
    } catch {
      // Ignore errors
    }
  }, [])

  const content = (
    <>
      {loading ? (
        <div className="text-sm text-muted-foreground py-4 text-center">
          {t('Loading...')}
        </div>
      ) : sessions.length === 0 ? (
        <div className="text-sm text-muted-foreground py-4 text-center space-y-1">
          <MessageSquare className="w-6 h-6 mx-auto mb-1 opacity-30" />
          <p>{t('No IM sessions yet')}</p>
          <p className="text-xs">{t('Sessions appear automatically when users message the bot')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {sessions.map((session) => {
            const channelInfo = getChannelDisplay(session.channel)
            const key = `${session.appId}:${session.channel}:${session.chatId}`
            const resolvedAppName = isGlobalMode ? (appNames[session.appId] || session.appId.slice(0, 8)) : null

            return (
              <div
                key={key}
                className="flex items-center gap-3 p-3 rounded-lg bg-muted/50 hover:bg-muted/70 transition-colors group/session"
              >
                {/* Chat type icon */}
                {session.chatType === 'group' ? (
                  <Users className="w-4 h-4 text-muted-foreground shrink-0" />
                ) : (
                  <User className="w-4 h-4 text-muted-foreground shrink-0" />
                )}

                {/* Session info */}
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
                          {getImSessionDisplayName(session)}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleStartRename(session)}
                          className="p-0.5 text-muted-foreground hover:text-foreground transition-colors rounded opacity-0 group-hover/session:opacity-100"
                          title={t('Rename')}
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                      </>
                    )}
                    <span className={`text-xs ${channelInfo.color} shrink-0`}>
                      {channelInfo.label}
                    </span>
                  </div>
                  {session.lastSender && session.lastMessage && (
                    <div className="text-xs text-muted-foreground mt-0.5 truncate">
                      {session.lastSender}: {session.lastMessage}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground/60 mt-0.5">
                    {resolvedAppName && (
                      <><span className="font-medium">{resolvedAppName}</span>{' · '}</>
                    )}
                    {session.chatType === 'group' ? t('Group') : t('Direct')}
                    {' · '}
                    {formatTime(session.lastActiveAt)}
                    {' · '}
                    <span className="font-mono text-[10px] break-all">{session.chatId}</span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleCopyContact(session)}
                    className="p-1 text-muted-foreground hover:text-foreground transition-colors rounded opacity-0 group-hover/session:opacity-100"
                    title={t('Copy contact info')}
                  >
                    {copiedKey === key
                      ? <Check className="w-3.5 h-3.5 text-green-500" />
                      : <Copy className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemove(session)}
                    className="p-1 text-muted-foreground hover:text-red-500 transition-colors rounded"
                    title={t('Remove session')}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Help text */}
      {!compact && (
        <div className="mt-4 p-3 rounded-lg bg-muted/30 text-xs text-muted-foreground space-y-1">
          <p>{t('These sessions are available as contacts for the digital human\'s IM push capability.')}</p>
          <p>{t('Edit display names to help the AI match your natural language instructions (e.g., "Marketing Group").')}</p>
        </div>
      )}
    </>
  )

  if (compact) {
    return content
  }

  return (
    <section id="im-sessions" className="bg-card rounded-xl border border-border p-6">
      <div className="mb-4">
        <div className="flex items-center gap-3">
          <Radio className="w-5 h-5 text-muted-foreground" />
          <div>
            <h2 className="text-lg font-medium">
              {t('IM Sessions')}
              {appName && <span className="text-sm text-muted-foreground ml-2">— {appName}</span>}
            </h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              {t('Manage IM conversation sessions')}
            </p>
          </div>
        </div>
      </div>
      {content}
    </section>
  )
}
