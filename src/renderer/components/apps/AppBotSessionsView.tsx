/**
 * AppBotSessionsView
 *
 * Session browser for one bound bot instance: a conversation list on the left,
 * the selected conversation's read-only transcript on the right — the same
 * list-left/content-right convention as the main conversation board
 * (ConversationList + ChatView), scoped to one bot instead of one space.
 *
 * This is the only place a bot's sessions render as a list; the Overview
 * card and Settings' Bot Access section both link here rather than expanding
 * the list inline, because a bot can accumulate far more contacts than either
 * surface has room for.
 */

import { useState, useCallback, useRef } from 'react'
import { MessageSquare } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { AppContactsList } from './AppContactsList'
import { ImSessionDetailView } from './ImSessionDetailView'
import { ImNameResolutionBanner } from './ImNameResolutionBanner'
import type { ImSessionRecord } from '../../../shared/types/im-channel'

interface AppBotSessionsViewProps {
  appId: string
  spaceId: string
  /** Scopes the left pane to this bot's contacts only. */
  instanceId: string
}

function sessionKey(session: ImSessionRecord): string {
  return `${session.appId}:${session.channel}:${session.chatId}`
}

export function AppBotSessionsView({ appId, spaceId, instanceId }: AppBotSessionsViewProps) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<ImSessionRecord | null>(null)
  // Auto-select the first contact once, the same "land on the top conversation"
  // behavior as the main conversation board — but only the first time the list
  // arrives, so it never overrides a selection the user already made or made
  // and cleared.
  const didAutoSelect = useRef(false)
  const handleSessionsChange = useCallback((sessions: ImSessionRecord[]) => {
    if (didAutoSelect.current || sessions.length === 0) return
    didAutoSelect.current = true
    setSelected(sessions[0])
  }, [])

  return (
    <div className="flex flex-col h-full min-h-0">
      <ImNameResolutionBanner appId={appId} instanceId={instanceId} />
      <div className="flex flex-1 min-h-0">
        <div className="w-72 flex-shrink-0 border-r border-border overflow-y-auto px-3 py-3">
          <AppContactsList
            appId={appId}
            instanceId={instanceId}
            selectedKey={selected ? sessionKey(selected) : null}
            onSelect={setSelected}
            onSessionsChange={handleSessionsChange}
          />
        </div>
        <div className="flex-1 min-w-0">
          {selected ? (
            <ImSessionDetailView appId={appId} spaceId={spaceId} session={selected} />
          ) : (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-muted-foreground">
              <MessageSquare className="w-6 h-6 opacity-30" />
              <p className="text-sm">{t('Select a conversation')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
