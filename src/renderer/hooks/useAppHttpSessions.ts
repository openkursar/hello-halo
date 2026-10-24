/**
 * A digital human's remote calls: the sessions a backend opened with it through
 * Halo's HTTP API (registry `source: 'http'`).
 *
 * Read from the registry feed every digital-human conversation list shares
 * (`stores/app-chat-sessions`), so the detail header (does the IM / Remote tab
 * exist?) and the tab itself cost no read of their own. These sessions are shown
 * only on the digital human's page — never on the conversation board.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  acquireAppChatSessions,
  getAppChatSessions,
  isAppChatSessionsLoading,
  subscribeAppChatSessions,
} from '../stores/app-chat-sessions'
import type { ImSessionRecord } from '../../shared/types/im-channel'

/** `appId`'s HTTP sessions among `records`, most recently active first. */
export function selectHttpSessions(records: ImSessionRecord[], appId: string): ImSessionRecord[] {
  return records
    .filter(record => record.appId === appId && record.source === 'http')
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
}

export function useAppHttpSessions(appId: string): { sessions: ImSessionRecord[]; loading: boolean } {
  const records = useSyncExternalStore(subscribeAppChatSessions, getAppChatSessions)
  const loading = useSyncExternalStore(subscribeAppChatSessions, isAppChatSessionsLoading)

  useEffect(() => acquireAppChatSessions(), [])

  const sessions = useMemo(() => selectHttpSessions(records, appId), [records, appId])
  return { sessions, loading }
}
