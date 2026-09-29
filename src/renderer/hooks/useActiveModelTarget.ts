/**
 * Whose model the header shows and edits.
 *
 * A regular conversation pins its own model, so the picker reads and writes
 * that conversation. A digital human has its own settings and never a
 * conversation-level pin: the header shows the model it is configured with and
 * sends the user to those settings — the picker must never write to any
 * conversation while a digital human is on screen.
 */

import { useChatStore, selectActiveConversationId, conversationKind, digitalHumanAppId } from '../stores/chat.store'
import { useAppsStore } from '../stores/apps.store'
import { resolveSpecI18n } from '../utils/spec-i18n'
import { getCurrentLanguage } from '../i18n'
import type { Conversation } from '../types'
import type { InstalledApp } from '../../shared/apps/app-types'

export type ActiveModelTarget =
  | { kind: 'conversation'; conversationId: string | null; conversation: Conversation | null }
  | { kind: 'digital-human'; appId: string; appName: string; modelSourceId?: string; modelId?: string }

/** Pure resolution, so the rule can be tested without React. */
export function resolveActiveModelTarget(
  conversationId: string | null,
  conversation: Conversation | null,
  app: Pick<InstalledApp, 'spec' | 'userOverrides'> | undefined
): ActiveModelTarget {
  const appId = conversationId && conversationKind(conversationId) === 'digital-human'
    ? digitalHumanAppId(conversationId)
    : null
  if (appId) {
    return {
      kind: 'digital-human',
      appId,
      appName: app ? resolveSpecI18n(app.spec, getCurrentLanguage()).name || appId : appId,
      modelSourceId: app?.userOverrides.modelSourceId,
      modelId: app?.userOverrides.modelId,
    }
  }
  return { kind: 'conversation', conversationId, conversation }
}

export function useActiveModelTarget(): ActiveModelTarget {
  const conversationId = useChatStore(selectActiveConversationId)
  const appId = conversationId && conversationKind(conversationId) === 'digital-human'
    ? digitalHumanAppId(conversationId)
    : null

  // Subscribed by reference so streaming tokens do not re-render the header.
  const conversation = useChatStore(s => !appId && conversationId ? s.conversationCache.get(conversationId) ?? null : null)
  const app = useAppsStore(s => appId ? s.apps.find(a => a.id === appId) : undefined)

  return resolveActiveModelTarget(conversationId, conversation, app)
}
