/** A peer's delivery is a source line, not a message from the person. */

import { useEffect, useState } from 'react'
import { Send, ExternalLink } from 'lucide-react'
import type { Message } from '../../../types'
import { getCurrentLanguage, useTranslation } from '../../../i18n'
import { useChatStore } from '../../../stores/chat.store'
import { useAppsStore } from '../../../stores/apps.store'
import { nativeChatAppId, parseRunSenderKey } from '../../../../shared/apps/im-keys'
import { navigateToAppChat, navigateToConversation } from '../../../utils/conversation-navigation'
import { formatRunStart } from '../../../utils/format-time'
import { readProvenance } from './message-source'
import { clipSubject, PROCESS_CUE, PROCESS_DETAIL, PROCESS_LINE, PROCESS_TIME } from '../process-line'

/**
 * A delivery this recent is treated as still unhandled by this conversation's
 * AI: it opens itself, then settles back to the collapsed resting state. The
 * renderer has no signal for "the AI has read it", so arrival time stands in.
 */
const FRESH_DELIVERY_MS = 5_000

interface CrossConversationMessageProps {
  message: Message
  /**
   * Received while a reply was being written: drawn as a line of that reply's
   * work, shaped like the operations around it.
   */
  inProcess?: boolean
}

export function CrossConversationMessage({ message, inProcess = false }: CrossConversationMessageProps) {
  const { t } = useTranslation()
  const provenance = readProvenance(message)

  const [isFresh, setIsFresh] = useState(
    () => !inProcess && Date.now() - new Date(message.timestamp).getTime() < FRESH_DELIVERY_MS
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

  const sentAt = new Date(message.timestamp).getTime()

  // A scheduled run's notice: named by its own title, with nowhere to open.
  const fromRun = parseRunSenderKey(provenance.fromConversationId) !== null
  const isSourceAvailable = sourceAppId ? digitalHumanAvailable : liveTitle !== undefined
  const displayTitle = liveTitle ?? provenance.fromConversationTitle

  const openSource = () => {
    if (!isSourceAvailable) return
    if (sourceAppId && sourceApp?.spaceId) {
      navigateToAppChat(sourceApp.spaceId, sourceAppId, provenance.fromConversationId)
      return
    }
    if (!currentSpaceId) return
    navigateToConversation(currentSpaceId, provenance.fromConversationId)
  }

  const body = isExpanded && (
    <div className={PROCESS_DETAIL}>
      <div className="text-[13px] leading-[1.7] text-foreground/[0.88] whitespace-pre-wrap [overflow-wrap:anywhere]">
        {message.content}
      </div>
      {/* /80 rather than the /55-/60 used for incidental meta elsewhere: this row
          carries "sent by that conversation's AI", the only visual statement that this
          message is not the user's. Measured at /55 it lands near 3:1 in dark mode,
          under the 4.5:1 floor — too weak for the one line that has to be read. */}
      <div className="mt-1 flex min-h-6 flex-wrap items-center gap-x-1 gap-y-0.5 text-[11px] text-muted-foreground/80 [overflow-wrap:anywhere]">
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
        <span>·</span>
        <span>{fromRun ? t('one-way notice from a scheduled run, no reply possible') : t("sent by that conversation's AI")}</span>
      </div>
    </div>
  )

  return (
    <div className={inProcess ? 'min-w-0' : 'w-[85%] min-w-0'} data-message-id={message.id}>
      <button type="button" onClick={() => setIsExpanded(v => !v)} aria-expanded={isExpanded} className={PROCESS_LINE}>
        <Send size={14} aria-hidden="true" className={`shrink-0 ${isFresh ? 'text-primary' : ''}`} />
        <span className={`${provenance.summary ? 'max-w-[45%] shrink-0' : 'min-w-0'} truncate`}>{t('From @{{title}}:', { title: displayTitle })}</span>
        {provenance.summary && (
          <span className="min-w-0 truncate text-[13px] text-muted-foreground">{inProcess ? clipSubject(provenance.summary).text : provenance.summary}</span>
        )}
        <span aria-hidden="true" className={PROCESS_CUE}>{isExpanded ? t('Collapse') : t('View')}</span>
        {Number.isFinite(sentAt) && (
          <time dateTime={new Date(sentAt).toISOString()} className={PROCESS_TIME}>{formatRunStart(sentAt, Date.now(), getCurrentLanguage())}</time>
        )}
      </button>
      {body}
    </div>
  )
}
