/**
 * Synthesizes "digital-human conversation" rows for the main conversation
 * board.
 *
 * Digital-human chats (app-chat:*) are never written into the space's
 * ConversationMeta[] index (see im-session-registry.ts's `native`/`local`
 * source docs) — their truth lives in per-app JSONL + the IM session
 * registry. This hook merges the app list with the registry's activity
 * summaries into a single view model so ConversationList can render them
 * alongside regular conversations without either storage system knowing
 * about the other.
 *
 * One row per conversation that actually exists — the app's legacy default
 * session once it has been used, plus every local session (each created
 * explicitly by picking the digital human in the input or the resource rail).
 * A digital human with no conversations contributes no rows.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { api } from '../api'
import { useAppChatPinsStore } from '../stores/app-chat-pins.store'
import { useSpaceDigitalHumans } from './useSpaceDigitalHumans'
import { getCurrentLanguage } from '../i18n'
import { resolveSpecI18n } from '../utils/spec-i18n'
import { getAppChatConversationId } from '../api/_shared'
import { buildLocalSessionKey } from '../../shared/apps/im-keys'
import type { ImSessionRecord } from '../../shared/types/im-channel'
import type { AppStatus } from '../../shared/apps/app-types'

/** Poll interval for the registry summary — matches ImSessionsSection's cadence. */
const POLL_INTERVAL_MS = 15_000

export interface AppChatConversationRow {
  /** conversationId — native default ("app-chat:{appId}") or a 5-segment local key. */
  id: string
  appId: string
  /** The app's home space; null for a global digital human. */
  appSpaceId: string | null
  /** Resolved digital-human display name — used as the section header, never per-row. */
  digitalHumanName: string
  /** True for the app's single native default session. */
  isDefault: boolean
  /** Raw registry fields for non-default rows — used to derive a per-row label. */
  customName?: string
  displayName: string
  lastMessage?: string
  /** Epoch ms; falls back to the app's last run / install time when never chatted. */
  updatedAt: number
  /** Absent (not just 0) when the registry has no record yet — safe-default distinction. */
  messageCount: number | undefined
  starred: boolean
  status: AppStatus
  uninstalled: boolean
}

/**
 * Read all app-chat conversation rows in scope for a space. Digital-human
 * data is intentionally NOT scoped by appId when calling imSessionsList —
 * one unscoped call covers every app, mirroring ImSessionsSection's global
 * mode instead of one round trip per app.
 */
export function useAppChatConversationRows(spaceId: string | null): AppChatConversationRow[] {
  // Soft-deleted apps stay in: their past conversations remain listed (faded)
  // so reinstalling restores them instead of silently losing the history.
  const digitalHumans = useSpaceDigitalHumans(spaceId, { includeUninstalled: true })
  const pinnedForSpace = useAppChatPinsStore(s => (spaceId ? s.pinned[spaceId] : undefined))
  const [sessions, setSessions] = useState<ImSessionRecord[]>([])

  const fetchSessions = useCallback(async () => {
    try {
      const res = await api.imSessionsList()
      if (res.success && Array.isArray(res.data)) {
        setSessions(res.data as ImSessionRecord[])
      }
    } catch (err) {
      console.error('[useAppChatConversationRows] fetchSessions error:', err)
    }
  }, [])

  useEffect(() => {
    fetchSessions()
    const interval = setInterval(fetchSessions, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [fetchSessions])

  // Real-time refresh on send/clear/delete — the poll above is only the
  // fallback for events missed while the tab was backgrounded.
  useEffect(() => {
    const unsub = api.onImSessionUpdated?.(() => { fetchSessions() })
    return () => { unsub?.() }
  }, [fetchSessions])

  return useMemo(() => {
    if (!spaceId) return []
    const locale = getCurrentLanguage()
    const pinned = pinnedForSpace ?? []
    const rows: AppChatConversationRow[] = []

    for (const app of digitalHumans) {
      const { name } = resolveSpecI18n(app.spec, locale)
      const digitalHumanName = name || app.id
      const status: AppStatus = app.status ?? 'active'
      const uninstalled = status === 'uninstalled'
      const fallbackUpdatedAt = app.lastRunAt ?? app.installedAt

      // Only when it actually holds a conversation: the record is written on
      // first send, so an untouched digital human would otherwise contribute
      // an empty placeholder row to a list that exists to show conversations.
      // Starting one is the input selector's job, not this list's.
      const defaultRecord = sessions.find(s => s.appId === app.id && s.source === 'native')
      const defaultConversationId = getAppChatConversationId(app.id)
      if (defaultRecord && ((defaultRecord.messageCount ?? 0) > 0 || defaultRecord.lastMessage)) {
        rows.push({
          id: defaultConversationId,
          appId: app.id,
          appSpaceId: app.spaceId ?? null,
          digitalHumanName,
          isDefault: true,
          displayName: digitalHumanName,
          lastMessage: defaultRecord.lastMessage,
          updatedAt: defaultRecord.lastActiveAt ?? fallbackUpdatedAt,
          messageCount: defaultRecord.messageCount,
          starred: pinned.includes(defaultConversationId),
          status,
          uninstalled,
        })
      }

      const localSessions = sessions.filter(s => s.appId === app.id && s.source === 'local')
      for (const session of localSessions) {
        const conversationId = buildLocalSessionKey(app.id, session.chatId)
        rows.push({
          id: conversationId,
          appId: app.id,
          appSpaceId: app.spaceId ?? null,
          digitalHumanName,
          isDefault: false,
          customName: session.customName,
          displayName: session.displayName,
          lastMessage: session.lastMessage,
          updatedAt: session.lastActiveAt,
          messageCount: session.messageCount,
          starred: pinned.includes(conversationId),
          status,
          uninstalled,
        })
      }
    }

    return rows
  }, [digitalHumans, sessions, pinnedForSpace, spaceId])
}
