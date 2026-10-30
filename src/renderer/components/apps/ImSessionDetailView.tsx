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

import { useState, useCallback, useRef } from 'react'
import { ArrowRightToLine, Loader2 } from 'lucide-react'
import { getCurrentLanguage, useTranslation } from '../../i18n'
import { useEngineCapabilities } from '../../stores/engine.store'
import { useAppsStore } from '../../stores/apps.store'
import { useChatStore } from '../../stores/chat.store'
import { useConversationEngineId } from '../../hooks/useConversationEngine'
import { api } from '../../api'
import { ImChatView } from './ImChatView'
import { EngineRecoveryNotice } from '../settings/EngineRecoveryNotice'
import { resolveSpecI18n } from '../../utils/spec-i18n'
import { navigateToAppChat } from '../../utils/conversation-navigation'
import { buildImSessionKey } from '../../../shared/apps/im-keys'
import type { ImSessionRecord } from '../../../shared/types/im-channel'
import type { AppChatEngineMetadata } from '../../../shared/apps/app-types'
import type { EngineId } from '../../../shared/types/engine'

interface ImSessionDetailViewProps {
  appId: string
  spaceId: string
  session: ImSessionRecord
}

export function ImSessionDetailView({ appId, spaceId, session }: ImSessionDetailViewProps) {
  const { t } = useTranslation()
  const conversationId = buildImSessionKey(appId, session.channel, session.chatType, session.chatId)
  const activeConversation = useRef(conversationId)
  activeConversation.current = conversationId
  const [reportedEngine, setReportedEngine] = useState<{ conversationId: string; engineId?: EngineId } | null>(null)
  const acceptEngineMetadata = useCallback((sourceConversationId: string, metadata: AppChatEngineMetadata) => {
    if (sourceConversationId !== activeConversation.current) return
    const engineId = metadata.engineId ?? metadata.engineBinding?.engineId
    setReportedEngine(previous => previous?.conversationId === sourceConversationId && previous.engineId === engineId
      ? previous : { conversationId: sourceConversationId, engineId })
  }, [])
  const app = useAppsStore(state => state.apps.find(item => item.id === appId))
  const engineFailure = useChatStore(state => {
    const live = state.sessions.get(conversationId)
    return live?.errorType === 'engine_unavailable' ? live.error : null
  })
  const preferredEngine = app?.userOverrides.engineId
  const engineId = useConversationEngineId(conversationId, spaceId, reportedEngine?.conversationId === conversationId ? reportedEngine.engineId ?? preferredEngine : preferredEngine)
  const capabilities = useEngineCapabilities(engineId)
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
      onEngineMetadata={acceptEngineMetadata}
      engineNotice={app && <EngineRecoveryNotice engineId={engineId} failure={engineFailure} target={{
        kind: 'digital-human', appId, appName: resolveSpecI18n(app.spec, getCurrentLanguage()).name || appId,
        modelSourceId: app.userOverrides.modelSourceId, modelId: app.userOverrides.modelId,
      }} />}
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
