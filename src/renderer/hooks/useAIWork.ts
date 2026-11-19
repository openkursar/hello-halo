/**
 * What people see of the AI's work on its canvas tabs: whether the AI is
 * operating a tab right now, and whose work it is. Read from the terminal and
 * AI-browser stores, which main keeps current (the operating state is already
 * held steady there, see shared/ai-operating.ts).
 */

import { useAIBrowserStore, selectPageOperating, selectPageOperator } from '../stores/ai-browser.store'
import { useTerminalStore } from '../stores/terminal.store'
import { useChatStore, selectActiveConversationId } from '../stores/chat.store'
import { useAppsStore } from '../stores/apps.store'
import { useSpaceStore } from '../stores/space.store'
import { useTranslation } from '../i18n'
import { parseNativeChatKey, parseRunSenderKey } from '../../shared/apps/im-keys'
import type { TabState } from '../services/canvas-lifecycle'

type WorkTab = Pick<TabState, 'type' | 'terminalSessionId' | 'browserViewId'>

/** Whether the AI is operating what this tab shows. */
export function useAIWorkOperating(tab: WorkTab): boolean {
  const terminal = useTerminalStore(state => (tab.type === 'terminal' && tab.terminalSessionId ? state.operating.has(tab.terminalSessionId) : false))
  const page = useAIBrowserStore(state => tab.type === 'browser' && selectPageOperating(state, tab.browserViewId))
  return terminal || page
}

/** The conversation whose AI works in this tab, when known. */
function useAIWorkConversation(tab: WorkTab): string | null {
  const terminal = useTerminalStore(state => (tab.type === 'terminal' && tab.terminalSessionId ? state.operators.get(tab.terminalSessionId) ?? null : null))
  const page = useAIBrowserStore(state => tab.type === 'browser' && tab.browserViewId
    ? selectPageOperator(state, tab.browserViewId) ?? state.pages[tab.browserViewId]?.conversationId ?? null
    : null)
  return terminal ?? page
}

/** The digital human whose chat, or whose run started from the desktop, a conversation key belongs to. */
export function workOwnerAppId(conversationId: string): string | null {
  return parseNativeChatKey(conversationId)?.appId ?? parseRunSenderKey(conversationId)?.appId ?? null
}

/**
 * Whose work the tab shows, named the way people know it — a digital human's
 * name or the conversation's title — or null when it is the conversation on
 * screen (or not known).
 */
export function useAIWorkOwnerLabel(tab: WorkTab): string | null {
  const { t } = useTranslation()
  const conversationId = useAIWorkConversation(tab)
  const onScreen = useChatStore(selectActiveConversationId)
  const appId = conversationId ? workOwnerAppId(conversationId) : null
  const appName = useAppsStore(state => (appId ? state.apps.find(app => app.id === appId)?.spec.name ?? null : null))
  // A space conversation works only in its own space, the one whose canvas shows this tab.
  const spaceId = useSpaceStore(state => state.currentSpace?.id ?? null)
  const title = useChatStore(state => {
    if (!conversationId || appId || !spaceId) return null
    return state.spaceStates.get(spaceId)?.conversations.find(conversation => conversation.id === conversationId)?.title || null
  })
  if (!conversationId || conversationId === onScreen) return null
  if (appId) return appName || t('Digital human')
  return title || t('Conversation')
}

/** Whether the AI is operating any tab of the space on screen right now (the canvas handle's dot). */
export function useSpaceAIOperating(): boolean {
  const spaceId = useSpaceStore(state => state.currentSpace?.id ?? null)
  const terminal = useTerminalStore(state => {
    if (!spaceId) return false
    for (const sessionId of state.operating) {
      const session = state.sessions.get(sessionId)
      if (session?.spaceId === spaceId && session.aiTouched && session.state === 'running') return true
    }
    return false
  })
  const page = useAIBrowserStore(state => {
    if (!spaceId) return false
    for (const conversationId of Object.keys(state.operating)) {
      const viewId = state.views[conversationId]?.viewId
      if (viewId && state.pages[viewId]?.spaceId === spaceId) return true
    }
    return false
  })
  return terminal || page
}
