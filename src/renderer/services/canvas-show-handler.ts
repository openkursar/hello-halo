/**
 * This client's part of `canvas_show`: the AI asks to bring its page, a
 * terminal or a file in front of the user. The tab is always made sure of, in
 * the conversation's space. The screen switches to it only when this client
 * shows that very conversation to a person who is not typing, and only for
 * something this client can display; otherwise the tab waits there quietly.
 * Main gathers every client's answer.
 */

import { api } from '../api'
import { isElectron } from '../api/transport'
import { useAppStore } from '../stores/app.store'
import { useChatStore, selectActiveConversationId } from '../stores/chat.store'
import { selectViewedConversationId } from '../stores/chat/active'
import { presentedBrowserPage } from '../browser-host'
import { canvasLifecycle } from './canvas-lifecycle'
import { isUserTyping } from './typing-activity'
import type { CanvasShowClientOutcome, CanvasShowRequest } from '../../shared/types/canvas-show'

/** Whether this client shows `conversationId` of `spaceId` to someone right now. */
function showsConversation(spaceId: string, conversationId: string): boolean {
  if (useAppStore.getState().view !== 'space') return false
  if (canvasLifecycle.getCurrentSpaceId() !== spaceId) return false
  return selectViewedConversationId(useChatStore.getState()) === conversationId
}

function ensureTab(request: CanvasShowRequest, presenting: boolean): string | null {
  const { spaceId, target } = request
  const now = Date.now()
  if (target.kind === 'page') {
    return canvasLifecycle.ensureAIWorkTab(spaceId, { kind: 'page', viewId: target.viewId, url: target.url, title: target.title, activityAt: now })
  }
  if (target.kind === 'terminal') {
    return canvasLifecycle.ensureAIWorkTab(spaceId, { kind: 'terminal', sessionId: target.sessionId, title: target.title, activityAt: now })
  }
  return canvasLifecycle.ensureFileTab(spaceId, target.path, presenting)
}

function isPresenting(request: CanvasShowRequest, tabId: string): boolean {
  return useAppStore.getState().view === 'space' &&
    canvasLifecycle.getCurrentSpaceId() === request.spaceId &&
    selectActiveConversationId(useChatStore.getState()) === request.conversationId &&
    !document.hidden && document.hasFocus() &&
    canvasLifecycle.getIsOpen() && canvasLifecycle.getActiveTabId() === tabId
}

function targetVisible(request: CanvasShowRequest, tabId: string): boolean {
  const tab = canvasLifecycle.getTab(tabId)
  if (!tab || tab.error || tab.isLoading || tab.contentUnloaded) return false
  if (request.target.kind === 'page' || (tab.type === 'pdf' && isElectron())) {
    return !!tab.browserViewId &&
      (request.target.kind !== 'page' || tab.browserViewId === request.target.viewId) &&
      !tab.browserState?.blockedByPolicy && !!presentedBrowserPage(tab.browserViewId)
  }
  const content = document.querySelector<HTMLElement>(
    `[data-canvas-tab-content="${CSS.escape(tabId)}"] [data-canvas-content-ready="true"]`,
  )
  return !!content?.getClientRects().length
}

async function waitForPresentation(request: CanvasShowRequest, tabId: string, until: number): Promise<boolean> {
  while (Date.now() < until && isPresenting(request, tabId)) {
    if (!canvasLifecycle.hasSpaceTab(request.spaceId, tabId) || canvasLifecycle.getTab(tabId)?.error) break
    if (targetVisible(request, tabId)) return true
    await new Promise<void>(resolve => setTimeout(resolve, 32))
  }
  return false
}

export async function presentCanvasShow(request: CanvasShowRequest): Promise<CanvasShowClientOutcome> {
  // Leave time to deliver the answer, and use the client's clock for the local wait.
  const until = Date.now() + Math.min(1500, request.replyWithinMs / 2)
  const displayable = request.target.kind !== 'page' || isElectron()
  const onScreen = showsConversation(request.spaceId, request.conversationId)
  const presenting = displayable && onScreen && request.bringForward && !isUserTyping()
  const tabId = ensureTab(request, presenting)
  if (!tabId) return 'unavailable'
  const kept = () => canvasLifecycle.hasSpaceTab(request.spaceId, tabId) ? 'added' : 'unavailable'
  if (!displayable) return kept()
  if (onScreen && isPresenting(request, tabId)) {
    return await waitForPresentation(request, tabId, until) ? 'shown' : kept()
  }
  if (!presenting || !showsConversation(request.spaceId, request.conversationId) || isUserTyping()) return kept()
  try {
    // Open with activation, not in a continuation after the user may have left.
    await canvasLifecycle.switchTab(tabId, { open: true })
  } catch (error) {
    console.warn('[CanvasShow] Could not select the target tab', { requestId: request.requestId, error })
    return kept()
  }
  if (await waitForPresentation(request, tabId, until)) return 'shown'
  return canvasLifecycle.hasSpaceTab(request.spaceId, tabId) ? 'opened' : 'unavailable'
}

/** Answers the AI's show requests for this client; returns the stop function. Called once from App. */
export function startCanvasShowHandler(): () => void {
  return api.onCanvasShowRequest(request => {
    void presentCanvasShow(request)
      .catch(error => {
        console.error('[CanvasShow] Could not confirm the target tab', { requestId: request.requestId }, error)
        return 'unavailable' as const
      })
      .then(outcome => api.replyCanvasShow({ requestId: request.requestId, outcome }))
      .catch(error => console.error('[CanvasShow] Answering a show request failed', { requestId: request.requestId }, error))
  })
}
