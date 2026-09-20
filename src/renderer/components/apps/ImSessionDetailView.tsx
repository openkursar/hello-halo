/**
 * ImSessionDetailView
 *
 * One external (IM) conversation as its own page. Owns the "Continue in
 * client" fork action and hands it to ImChatView's footerAction slot, so it
 * renders inside the read-only bar rather than as a separate row — it acts on
 * the conversation you are reading, not on a list entry.
 *
 * Forking copies the transcript and the model session into a new digital-human
 * conversation on the main board; we navigate there so the user can continue.
 */

import { useState, useCallback } from 'react'
import { ArrowRightToLine, Loader2 } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useEngineCapabilities } from '../../stores/engine.store'
import { api } from '../../api'
import { ImChatView } from './ImChatView'
import { navigateToAppChat } from '../pulse'
import { buildImSessionKey } from '../../../shared/apps/im-keys'
import type { ImSessionRecord } from '../../../shared/types/im-channel'

interface ImSessionDetailViewProps {
  appId: string
  spaceId: string
  session: ImSessionRecord
}

export function ImSessionDetailView({ appId, spaceId, session }: ImSessionDetailViewProps) {
  const { t } = useTranslation()
  const capabilities = useEngineCapabilities()
  const canFork = !!capabilities?.features.sessionFork
  const [forking, setForking] = useState(false)

  const handleFork = useCallback(async () => {
    if (!spaceId) return
    setForking(true)
    try {
      const conversationId = buildImSessionKey(appId, session.channel, session.chatType, session.chatId)
      const res = await api.appSessionFork(appId, spaceId, conversationId)
      const forked = res as { success?: boolean; data?: { conversationId?: string } }
      if (forked.success && forked.data?.conversationId) {
        navigateToAppChat(spaceId, appId, forked.data.conversationId)
      }
    } catch (err) {
      console.error('[ImSessionDetailView] Fork error:', err)
    } finally {
      setForking(false)
    }
  }, [appId, spaceId, session])

  return (
    <ImChatView
      appId={appId}
      spaceId={spaceId}
      session={session}
      footerAction={canFork && (
        <button
          onClick={handleFork}
          disabled={forking}
          title={t('Copies this conversation into a new chat with the digital human, where you can keep talking.')}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/10 rounded-full transition-colors disabled:opacity-50 flex-shrink-0"
        >
          {forking
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <ArrowRightToLine className="w-3.5 h-3.5" />}
          {t('Continue in client')}
        </button>
      )}
    />
  )
}
