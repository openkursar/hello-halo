/**
 * What closing a canvas tab ends. Closing the AI's tab ends its work for real
 * (a terminal's process, the AI's page); there is no background left to keep
 * it in. The user's own terminal ends with its tab as it always did. Prompts
 * live in CanvasCloseGuard; this decides and acts.
 */

import { api } from '../api'
import { useTerminalStore } from '../stores/terminal.store'
import { useAIBrowserStore, isPageInUseByOthers, selectPageOperating } from '../stores/ai-browser.store'
import { canEndOnThisClient } from './ai-work-tabs'
import type { CanvasClosePolicy, TabState } from './canvas-lifecycle'

export type EndOutcome = { ended: true } | { ended: false; reason: 'in-use' | 'not-owned' | 'failed' }

type ClosingTab = Pick<TabState, 'id' | 'type' | 'aiWork' | 'terminalSessionId' | 'browserViewId' | 'title'>

function runningTerminal(tab: ClosingTab) {
  if (tab.type !== 'terminal' || !tab.terminalSessionId) return undefined
  const info = useTerminalStore.getState().sessions.get(tab.terminalSessionId)
  return info?.state === 'running' ? info : undefined
}

/** Closing this tab ends the AI's work, so it is asked about first. */
export function closesAIWork(tab: ClosingTab): boolean {
  return !!tab.aiWork || !!runningTerminal(tab)?.aiTouched
}

/** A running terminal of the user's own that the AI never touched: it ends with its tab, unasked. */
export function isOwnRunningTerminal(tab: ClosingTab): boolean {
  const info = runningTerminal(tab)
  return !!info && !info.aiTouched
}

/** Whether the AI is operating this tab's work right now (it picks the close prompt's wording). */
export function isOperatingNow(tab: ClosingTab): boolean {
  if (tab.type === 'terminal') return !!tab.terminalSessionId && useTerminalStore.getState().operating.has(tab.terminalSessionId)
  return selectPageOperating(useAIBrowserStore.getState(), tab.browserViewId)
}

/** End what an AI tab runs. Main decides for pages; a page another conversation is on stays. */
export async function endAIWork(tab: ClosingTab, options: { silent?: boolean } = {}): Promise<EndOutcome> {
  if (tab.type === 'terminal') {
    if (!tab.terminalSessionId) return { ended: true }
    const ended = await useTerminalStore.getState().killSession(tab.terminalSessionId, options)
    return ended ? { ended: true } : { ended: false, reason: 'failed' }
  }
  if (!tab.browserViewId) return { ended: true }
  const state = useAIBrowserStore.getState()
  const page = state.pages[tab.browserViewId]
  // Gone already: closing the tab is all that is left.
  if (!page) return { ended: true }
  if (isPageInUseByOthers(state, tab.browserViewId)) return { ended: false, reason: 'in-use' }
  try {
    const result = await api.stopAIBrowserPage(tab.browserViewId, page.conversationId)
    if (result.stopped) return { ended: true }
    console.warn(`[AIWorkClose] Closing page ${tab.browserViewId} refused: ${result.reason ?? 'unavailable'}`)
    return { ended: false, reason: result.reason ?? 'failed' }
  } catch (error) {
    console.error(`[AIWorkClose] Closing page ${tab.browserViewId} failed:`, error)
    return { ended: false, reason: 'failed' }
  }
}

/** Ends the user's own running terminal with its tab; false when it could not be ended. */
export function endOwnTerminal(tab: ClosingTab, options: { silent?: boolean } = {}): Promise<boolean> {
  if (!tab.terminalSessionId) return Promise.resolve(true)
  return useTerminalStore.getState().killSession(tab.terminalSessionId, options)
}

/** The two questions the policy may ask; the guard component shows them. */
export interface CloseQuestions {
  /** Close this one tab of the AI's work, ending it? */
  confirmOne(tab: TabState, operating: boolean): Promise<boolean>
  /** Only the AI's work is left to close: end all of it? */
  confirmEndAll(tabs: readonly TabState[]): Promise<boolean>
  /** Some of the work could not be ended; the tabs stay. */
  reportNotEnded(outcomes: readonly EndOutcome[]): void
}

/**
 * What closing tabs ends, as a policy for the canvas lifecycle. Ending the AI's
 * work needs the user's answer; the user's own terminal ends with its tab; the
 * AI's page on a client that cannot end it is never closed.
 *
 * Closing several tabs closes the user's own and quietly keeps the AI's work:
 * that is nearly always what was meant, so nothing is asked. Only when the AI's
 * work is all that is being closed does closing mean ending it, and then it
 * asks once.
 */
export function createCloseDecisions(questions: CloseQuestions): CanvasClosePolicy {
  return {
    closeOne: async (tab) => {
      if (!closesAIWork(tab)) {
        return isOwnRunningTerminal(tab) ? endOwnTerminal(tab) : true
      }
      if (!canEndOnThisClient(tab)) return false
      if (!(await questions.confirmOne(tab, isOperatingNow(tab)))) return false
      const outcome = await endAIWork(tab)
      questions.reportNotEnded([outcome])
      return outcome.ended
    },

    closeMany: async (tabs) => {
      const aiWork = tabs.filter(closesAIWork)
      const keep = new Set(aiWork.map(tab => tab.id))
      const endable = aiWork.filter(canEndOnThisClient)
      if (aiWork.length === tabs.length && endable.length > 0) {
        if (!(await questions.confirmEndAll(endable))) return null
        const outcomes = await Promise.all(endable.map(tab => endAIWork(tab, { silent: true })))
        outcomes.forEach((outcome, index) => { if (outcome.ended) keep.delete(endable[index].id) })
        questions.reportNotEnded(outcomes)
        return { keep }
      }
      const own = tabs.filter(tab => !keep.has(tab.id) && isOwnRunningTerminal(tab))
      const ownEnded = await Promise.all(own.map(tab => endOwnTerminal(tab, { silent: true })))
      ownEnded.forEach((ended, index) => { if (!ended) keep.add(own[index].id) })
      return { keep }
    },

    endRemoved: async (tabs) => {
      // Main ends a removed space's work too; ending what is already gone is a no-op.
      await Promise.all(tabs.filter(tab => tab.type === 'terminal').map(tab => endOwnTerminal(tab, { silent: true })))
    },
  }
}
