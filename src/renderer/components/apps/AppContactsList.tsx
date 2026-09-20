/**
 * AppContactsList
 *
 * Conversation list for one bot instance: contacts that have reached this
 * digital human through it. Rename/remove live behind a "⋯" menu; auto-sync
 * stays a persistent checkbox with its own explanation (a bell icon alone
 * wasn't legible for what "the AI messages this contact proactively" means).
 * Used as the left pane of AppBotSessionsView — selecting a row shows that
 * conversation on the right, the same click-to-switch pattern as the main
 * conversation board.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { Users, User, Pencil, Trash2, Search, MessageSquare, EllipsisVertical } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import type { ImSessionRecord } from '../../../shared/types/im-channel'
import { getImSessionDisplayName } from '../../../shared/types/im-channel'

const IM_CHANNEL_LABEL: Record<string, string> = {
  'wecom-bot': 'WeCom',
  'feishu-bot': 'Feishu',
  'dingtalk-bot': 'DingTalk',
  'weixin-ilink-bot': 'WeChat iLink',
}

function formatTime(ts: number): string {
  if (!ts) return '-'
  const d = new Date(ts)
  const now = new Date()
  const diffDays = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (diffDays === 1) return '1d ago'
  if (diffDays < 30) return `${diffDays}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function sessionKey(session: ImSessionRecord): string {
  return `${session.appId}:${session.channel}:${session.chatId}`
}

interface AppContactsListProps {
  appId: string
  /** Show only contacts that arrived through this channel instance. */
  instanceId?: string
  selectedKey?: string | null
  onSelect: (session: ImSessionRecord) => void
  /** Fires whenever the fetched list changes, so the parent can e.g. auto-select the first contact. */
  onSessionsChange?: (sessions: ImSessionRecord[]) => void
}

export function AppContactsList({ appId, instanceId, selectedKey, onSelect, onSessionsChange }: AppContactsListProps) {
  const { t } = useTranslation()
  const [sessions, setSessions] = useState<ImSessionRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [menuKey, setMenuKey] = useState<string | null>(null)
  const [confirmRemoveKey, setConfirmRemoveKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  /** Above this count, surface a search box and keep the list height-bounded. */
  const SEARCH_THRESHOLD = 8

  const fetchSessions = useCallback(async () => {
    try {
      const res = await api.imSessionsList(appId) as { success: boolean; data?: ImSessionRecord[] }
      if (res.success && res.data) {
        // Only IM sessions are pushable; HTTP sessions have no channel adapter.
        setSessions(res.data.filter(s => s.source === 'im' && (!instanceId || s.instanceId === instanceId)))
      }
    } catch {
      // Ignore
    } finally {
      setLoading(false)
    }
  }, [appId, instanceId])

  useEffect(() => {
    fetchSessions()
    const interval = setInterval(fetchSessions, 15_000)
    return () => clearInterval(interval)
  }, [fetchSessions])

  useEffect(() => { onSessionsChange?.(sessions) }, [sessions, onSessionsChange])

  const handleRemove = useCallback(async (session: ImSessionRecord) => {
    try {
      const result = await api.imSessionsRemove({
        appId: session.appId,
        channel: session.channel,
        chatId: session.chatId,
      })
      if (result.success) {
        setSessions(prev => prev.filter(s => sessionKey(s) !== sessionKey(session)))
      }
    } catch {
      // Ignore
    }
  }, [])

  const handleStartRename = useCallback((session: ImSessionRecord) => {
    setEditingKey(sessionKey(session))
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
        setSessions(prev => prev.map(s => sessionKey(s) === sessionKey(session) ? { ...s, customName: trimmed } : s))
      }
    } catch {
      // Ignore
    }
  }, [editingName])

  const handleToggleProactive = useCallback(async (session: ImSessionRecord) => {
    const next = !session.proactive
    // Optimistic update: flip immediately, revert on failure. The IPC round-
    // trip is fast on desktop but noticeable on remote — optimistic UI keeps
    // the toggle feeling responsive regardless of transport.
    setSessions(prev => prev.map(s => sessionKey(s) === sessionKey(session) ? { ...s, proactive: next } : s))
    try {
      const result = await api.imSessionsSetProactive({
        appId: session.appId,
        channel: session.channel,
        chatId: session.chatId,
        proactive: next,
      })
      if (!result.success) {
        setSessions(prev => prev.map(s => sessionKey(s) === sessionKey(session) ? { ...s, proactive: !next } : s))
      }
    } catch {
      setSessions(prev => prev.map(s => sessionKey(s) === sessionKey(session) ? { ...s, proactive: !next } : s))
    }
  }, [])

  if (loading) {
    return <div className="text-sm text-muted-foreground py-3 text-center">{t('Loading...')}</div>
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

  const q = query.trim().toLowerCase()
  const filtered = q
    ? sessions.filter((s) => getImSessionDisplayName(s).toLowerCase().includes(q) || s.chatId.toLowerCase().includes(q))
    : sessions

  return (
    <div className="space-y-2">
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

      {filtered.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-3">
          {t('No contacts match "{{query}}"', { query })}
        </p>
      )}

      <div className="space-y-0.5">
        {filtered.map((session) => {
          const key = sessionKey(session)
          const displayName = getImSessionDisplayName(session)
          const isSelected = selectedKey === key
          const isEditing = editingKey === key

          return (
            <div
              key={key}
              role="button"
              tabIndex={0}
              onClick={() => { if (!isEditing) onSelect(session) }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !isEditing) onSelect(session) }}
              className={`group/contact flex flex-col gap-2 p-2.5 rounded-lg cursor-pointer transition-colors ${
                isSelected ? 'bg-primary/10 ring-1 ring-primary' : 'hover:bg-secondary/60'
              }`}
            >
              <div className="flex items-center gap-2.5">
                {session.chatType === 'group'
                  ? <Users className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  : <User className="w-4 h-4 text-muted-foreground flex-shrink-0" />}

                <div className="flex-1 min-w-0">
                  {isEditing ? (
                    <input
                      ref={renameInputRef}
                      type="text"
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onBlur={() => handleCommitRename(session)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleCommitRename(session)
                        if (e.key === 'Escape') setEditingKey(null)
                      }}
                      className="text-sm font-medium bg-background border border-border rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-primary w-full"
                    />
                  ) : (
                    <p className="text-sm font-medium text-foreground truncate">{displayName}</p>
                  )}
                  <p className="text-[11px] text-muted-foreground truncate">
                    {IM_CHANNEL_LABEL[session.channel] ?? session.channel} · {session.chatType === 'group' ? t('Group') : t('Direct')} · {formatTime(session.lastActiveAt)}
                  </p>
                </div>

                <div className="relative flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    onClick={() => { setMenuKey(menuKey === key ? null : key); setConfirmRemoveKey(null) }}
                    title={t('More')}
                    className={`p-1 text-muted-foreground hover:text-foreground transition-colors rounded ${
                      menuKey === key ? 'opacity-100 bg-secondary' : 'opacity-0 group-hover/contact:opacity-100'
                    }`}
                  >
                    <EllipsisVertical className="w-3.5 h-3.5" />
                  </button>
                  {menuKey === key && (
                    confirmRemoveKey === key ? (
                      <div className="absolute right-0 top-full mt-1 z-20 w-52 bg-popover border border-border rounded-lg shadow-lg p-2.5 space-y-2">
                        <p className="text-xs text-foreground">{t('Remove this contact?')}</p>
                        <p className="text-[11px] text-muted-foreground">{t('It stays reachable — this only removes it from the list.')}</p>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => { setMenuKey(null); setConfirmRemoveKey(null); handleRemove(session) }}
                            className="px-2 py-1 text-xs text-red-500 border border-red-500/30 hover:bg-red-500/10 rounded transition-colors"
                          >
                            {t('Remove')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmRemoveKey(null)}
                            className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground rounded transition-colors"
                          >
                            {t('Cancel')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="absolute right-0 top-full mt-1 z-20 w-32 bg-popover border border-border rounded-lg shadow-lg overflow-hidden">
                        <button
                          type="button"
                          onClick={() => { setMenuKey(null); handleStartRename(session) }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-secondary transition-colors text-left"
                        >
                          <Pencil className="w-3 h-3" />
                          {t('Rename')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmRemoveKey(key)}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-500 hover:bg-secondary transition-colors text-left"
                        >
                          <Trash2 className="w-3 h-3" />
                          {t('Remove')}
                        </button>
                      </div>
                    )
                  )}
                </div>
              </div>

              {/* Auto-sync toggle: pushes the AI final reply to this contact at run end */}
              <label className="flex flex-col gap-0.5 cursor-pointer select-none" onClick={(e) => e.stopPropagation()}>
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={session.proactive === true}
                    onChange={() => handleToggleProactive(session)}
                    className="w-3.5 h-3.5 rounded border-border accent-primary cursor-pointer flex-shrink-0"
                  />
                  <span className="text-xs text-foreground">
                    {t('Auto-sync run result')}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground/70 pl-[22px]">
                  {t('Send the AI final reply to this contact after each successful run')}
                </span>
              </label>
            </div>
          )
        })}
      </div>
    </div>
  )
}
