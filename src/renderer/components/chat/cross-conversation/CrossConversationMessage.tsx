/**
 * CrossConversationMessage — a message delivered by another conversation in the
 * same space, rendered inside the receiving conversation's stream.
 *
 * The visual separation from a user bubble is the enforcement point of the rule
 * that a peer conversation is not the owner speaking. Three independent signals
 * carry it, so no single one being missed can cause a misread:
 *   1. left aligned, where user messages are right aligned
 *   2. weak `muted` fill + hairline border, where a user bubble is a primary fill
 *   3. 12px, where user body text is 14px
 *
 * Collapsed to a one-line summary by default; the model always receives the full
 * body regardless of this UI state.
 */

import { useEffect, useState } from 'react'
import { ChevronRight, Send, ExternalLink } from 'lucide-react'
import type { Message } from '../../../types'
import { useTranslation } from '../../../i18n'
import { useChatStore } from '../../../stores/chat.store'
import { useAppsStore } from '../../../stores/apps.store'
import { nativeChatAppId, parseRunSenderKey } from '../../../../shared/apps/im-keys'
import { navigateToAppChat, navigateToConversation } from '../../../utils/conversation-navigation'
import { formatTimeAgo } from '../../../utils/format-time'
import { readProvenance } from './message-source'

/**
 * A delivery this recent is treated as still unhandled by this conversation's
 * AI: it opens itself, then settles back to the collapsed resting state. The
 * renderer has no signal for "the AI has read it", so arrival time stands in.
 */
const FRESH_DELIVERY_MS = 5_000

interface CrossConversationMessageProps {
  message: Message
}

export function CrossConversationMessage({ message }: CrossConversationMessageProps) {
  const { t } = useTranslation()
  const provenance = readProvenance(message)

  const [isFresh, setIsFresh] = useState(
    () => Date.now() - new Date(message.timestamp).getTime() < FRESH_DELIVERY_MS
  )
  const [isExpanded, setIsExpanded] = useState(isFresh)

  const currentSpaceId = useChatStore(s => s.currentSpaceId)
  // A digital human's chat is not in the space's conversation list; it stays
  // reachable for as long as its digital human is installed.
  const sourceAppId = provenance ? nativeChatAppId(provenance.fromConversationId) : null
  const sourceApp = useAppsStore(s => (sourceAppId ? s.apps.find(a => a.id === sourceAppId) : undefined))
  const digitalHumanAvailable = !!sourceApp && sourceApp.status !== 'uninstalled' && !!sourceApp.spaceId
  // Resolve the source against the live conversation list so a rename shows the
  // current name; absence means it was deleted and the jump must be disabled.
  const liveTitle = useChatStore(s => {
    if (!provenance || !currentSpaceId || sourceAppId) return undefined
    return s.getSpaceState(currentSpaceId).conversations
      .find(c => c.id === provenance.fromConversationId)?.title
  })

  useEffect(() => {
    if (!isFresh) return
    const timer = setTimeout(() => {
      setIsFresh(false)
      setIsExpanded(false)
    }, FRESH_DELIVERY_MS)
    return () => clearTimeout(timer)
  }, [isFresh])

  if (!provenance) return null

  // A scheduled run's notice: named by its own title, with nowhere to open.
  const fromRun = parseRunSenderKey(provenance.fromConversationId) !== null
  const isSourceAvailable = sourceAppId ? digitalHumanAvailable : liveTitle !== undefined
  const displayTitle = liveTitle ?? provenance.fromConversationTitle
  const time = formatTimeAgo(new Date(message.timestamp).getTime(), t)

  const openSource = () => {
    if (!isSourceAvailable) return
    if (sourceAppId && sourceApp?.spaceId) {
      navigateToAppChat(sourceApp.spaceId, sourceAppId, provenance.fromConversationId)
      return
    }
    if (!currentSpaceId) return
    navigateToConversation(currentSpaceId, provenance.fromConversationId)
  }

  return (
    <div className="flex justify-start animate-fade-in" data-message-id={message.id}>
      <div className="max-w-[85%] min-w-0 rounded-xl bg-muted/15 border border-border-soft overflow-hidden">
        <button
          onClick={() => setIsExpanded(v => !v)}
          className={`w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left transition-colors
            hover:bg-muted/25 ${isFresh ? 'border-b border-primary/35' : ''}`}
        >
          <ChevronRight
            size={12}
            className={`shrink-0 text-muted-foreground/60 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          />
          <span
            className={`shrink-0 w-4 h-4 rounded-[5px] flex items-center justify-center
              ${isFresh ? 'bg-primary text-primary-foreground' : 'bg-primary/15 text-primary'}`}
          >
            <Send size={9} />
          </span>
          <span className="shrink-0 text-xs font-semibold text-primary/90">
            {t('From @{{title}}:', { title: displayTitle })}
          </span>
          {provenance.summary && (
            <span className="text-xs text-muted-foreground truncate min-w-0">
              {provenance.summary}
            </span>
          )}
          <span className="shrink-0 text-muted-foreground/40 text-[10px]">·</span>
          <span className="shrink-0 text-[10px] text-muted-foreground/55">{time}</span>
        </button>

        {isExpanded && (
          <div className="px-2.5 pb-2 animate-slide-down">
            <div className="text-[13px] leading-[1.7] text-foreground/[0.88] whitespace-pre-wrap break-words">
              {message.content}
            </div>
            {/* /80 rather than the /55-/60 used for incidental meta elsewhere: this row
                carries "sent by that conversation's AI", the only visual statement that this
                message is not the user's. Measured at /55 it lands near 3:1 in dark mode,
                under the 4.5:1 floor — too weak for the one line that has to be read. */}
            <div className="mt-2 pt-1.5 border-t border-dashed border-border-faint
              flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[10px] text-muted-foreground/80">
              <span>{t('From conversation')}</span>
              {fromRun ? (
                <span>{displayTitle}</span>
              ) : isSourceAvailable ? (
                <button
                  onClick={openSource}
                  className="inline-flex items-center gap-0.5 text-primary hover:underline"
                >
                  {displayTitle}
                  <ExternalLink size={9} />
                </button>
              ) : (
                <span className="text-muted-foreground/50 italic">{t('deleted conversation')}</span>
              )}
              <span>· {time} ·</span>
              <span>{fromRun ? t('one-way notice from a scheduled run, no reply possible') : t("sent by that conversation's AI")}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
