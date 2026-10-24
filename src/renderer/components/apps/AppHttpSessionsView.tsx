/**
 * AppHttpSessionsView
 *
 * A digital human's remote calls — sessions a backend holds with it through
 * Halo's HTTP API — in the same list-left / transcript-right browser as a bot's
 * sessions (AppBotSessionsView). Read-only: the backend talks to the digital
 * human through the API, and nothing here pushes to a call or hands it to
 * another conversation.
 *
 * A backend can open hundreds of calls (the registry keeps up to 500 per
 * digital human for 30 days), so the list draws the newest PAGE_SIZE and grows
 * on request. Nothing is opened until a call is picked: an open transcript
 * receives its call's live progress. On a narrow screen the transcript takes
 * the list's place.
 */

import { useState } from 'react'
import { ChevronLeft, MessageSquare, Webhook } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useConversationTaskStatus } from '../../stores/chat.store'
import { TaskStatusDot } from '../pulse/TaskStatusDot'
import { formatTimeAgo } from '../../utils/format-time'
import { ImSessionDetailView } from './ImSessionDetailView'
import { buildImSessionKey } from '../../../shared/apps/im-keys'
import { getImSessionDisplayName } from '../../../shared/types/im-channel'
import type { ImSessionRecord } from '../../../shared/types/im-channel'

const PAGE_SIZE = 30

interface AppHttpSessionsViewProps {
  appId: string
  spaceId: string
  /** This digital human's HTTP sessions, most recently active first. */
  sessions: ImSessionRecord[]
}

export function AppHttpSessionsView({ appId, spaceId, sessions }: AppHttpSessionsViewProps) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<ImSessionRecord | null>(null)
  const [shown, setShown] = useState(PAGE_SIZE)
  // Narrow screens show one pane: the picked call's transcript, until Back.
  const [reading, setReading] = useState(false)

  const selectedKey = selected ? buildImSessionKey(appId, selected.channel, selected.chatType, selected.chatId) : null

  return (
    <div className="flex h-full min-h-0">
      <div className={`${reading ? 'hidden' : 'block'} w-full overflow-y-auto px-3 py-3 sm:block sm:w-72 sm:flex-shrink-0 sm:border-r sm:border-border-faint`}>
        <div className="space-y-0.5">
          {sessions.slice(0, shown).map(session => {
            const conversationId = buildImSessionKey(appId, session.channel, session.chatType, session.chatId)
            return (
              <HttpSessionRow
                key={conversationId}
                conversationId={conversationId}
                session={session}
                selected={conversationId === selectedKey}
                onSelect={() => { setSelected(session); setReading(true) }}
              />
            )
          })}
        </div>
        {sessions.length > shown && (
          <button
            type="button"
            onClick={() => setShown(count => count + PAGE_SIZE)}
            className="mt-2 min-h-9 w-full rounded-lg text-xs text-muted-foreground hover:bg-secondary/60 hover:text-foreground transition-colors"
          >
            {t('Show more')}
          </button>
        )}
      </div>
      <div className={`${reading ? 'flex' : 'hidden'} min-w-0 flex-1 flex-col sm:flex`}>
        <button
          type="button"
          onClick={() => setReading(false)}
          className="flex min-h-9 flex-shrink-0 items-center gap-1 border-b border-border-faint px-3 text-xs text-muted-foreground hover:text-foreground sm:hidden"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          {t('Back')}
        </button>
        <div className="min-h-0 flex-1">
          {selected ? (
            // Keyed per call: a reused view would keep the previous call's
            // messages and graft them onto this transcript.
            <ImSessionDetailView key={selectedKey} appId={appId} spaceId={spaceId} session={selected} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <MessageSquare className="h-6 w-6 opacity-30" />
              <p className="text-sm">{t('Select a conversation')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

interface HttpSessionRowProps {
  conversationId: string
  session: ImSessionRecord
  selected: boolean
  onSelect: () => void
}

function HttpSessionRow({ conversationId, session, selected, onSelect }: HttpSessionRowProps) {
  const { t } = useTranslation()
  const status = useConversationTaskStatus(conversationId)

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex w-full items-start gap-2.5 rounded-lg p-2.5 text-left transition-colors ${
        // Same quiet selection as the conversation list: a fill, no accent edge.
        selected ? 'bg-secondary' : 'hover:bg-secondary/60'
      }`}
    >
      <Webhook className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{getImSessionDisplayName(session)}</p>
          <TaskStatusDot status={status} />
          <span className="flex-shrink-0 text-[11px] text-muted-foreground">{formatTimeAgo(session.lastActiveAt, t)}</span>
        </div>
        <p className="truncate text-[11px] text-muted-foreground">
          {t('Remote call')}{session.lastMessage ? ` · ${session.lastMessage}` : ''}
        </p>
      </div>
    </button>
  )
}
