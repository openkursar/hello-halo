/**
 * Title of the conversation on screen, for the page header.
 *
 * A regular conversation has its own title. A digital human's conversation is
 * named after the digital human, plus the conversation's own name once it has
 * one: the user's, else the title its first message gave it.
 */

import { useChatStore, selectActiveConversationId, conversationKind, digitalHumanAppId } from '../stores/chat.store'
import { useAppsStore } from '../stores/apps.store'
import { useAppChatConversationRows } from './useAppChatConversationRows'
import { resolveSpecI18n } from '../utils/spec-i18n'
import { getCurrentLanguage } from '../i18n'

export function useActiveConversationTitle(): string | undefined {
  const conversationId = useChatStore(selectActiveConversationId)
  const spaceId = useChatStore(s => s.currentSpaceId)
  const team = useChatStore(s => s.spaceStates.get(s.currentSpaceId ?? '')?.selectedTeamChat)
  const isDigitalHuman = !!conversationId && conversationKind(conversationId) === 'digital-human'
  const appId = isDigitalHuman ? digitalHumanAppId(conversationId) : null

  const regularTitle = useChatStore(s => {
    if (isDigitalHuman || !conversationId) return undefined
    const spaceState = s.spaceStates.get(s.currentSpaceId ?? '')
    return spaceState?.conversations?.find(c => c.id === conversationId)?.title || undefined
  })
  const app = useAppsStore(s => appId ? s.apps.find(a => a.id === appId) : undefined)
  const rows = useAppChatConversationRows(spaceId, { enabled: isDigitalHuman })

  if (team) return team.label || team.teamName
  if (!isDigitalHuman || !appId) return regularTitle
  const name = app ? resolveSpecI18n(app.spec, getCurrentLanguage()).name || appId : appId
  const row = rows.find(candidate => candidate.id === conversationId)
  const sessionName = row?.customName || row?.title
  return sessionName ? `${name} · ${sessionName}` : name
}
