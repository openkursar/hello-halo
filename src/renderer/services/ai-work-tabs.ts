/**
 * The AI's live work as canvas tabs: every running terminal the AI used and
 * every page an AI conversation opened, in the space it belongs to.
 *
 * Each client derives it from its own mirrors of main (the terminal and
 * AI-browser stores) and hands it to the canvas lifecycle, which adds missing
 * tabs quietly and drops marks when the work ends. It runs only when those
 * stores change membership — no timer, no polling, nothing at startup beyond
 * the stores' own seeding.
 */

import { useTerminalStore, type TerminalInfo } from '../stores/terminal.store'
import { useAIBrowserStore, type AIBrowserPage } from '../stores/ai-browser.store'
import { canvasLifecycle, type AIWorkItem, type TabState } from './canvas-lifecycle'
import { isElectron } from '../api/transport'

/** The AI's live work by space: what should have a tab, with its mark. */
export function collectAIWork(
  sessions: ReadonlyMap<string, TerminalInfo>,
  pages: Readonly<Record<string, AIBrowserPage>>,
  changedSpaces?: ReadonlySet<string>,
): Map<string, AIWorkItem[]> {
  const work = new Map<string, AIWorkItem[]>()
  const add = (spaceId: string, item: AIWorkItem) => {
    const items = work.get(spaceId)
    if (items) items.push(item)
    else work.set(spaceId, [item])
  }
  for (const session of sessions.values()) {
    if (session.state !== 'running' || !session.aiTouched || !session.spaceId || (changedSpaces && !changedSpaces.has(session.spaceId))) continue
    add(session.spaceId, { kind: 'terminal', sessionId: session.id, title: session.title, activityAt: session.lastActivityAt })
  }
  for (const page of Object.values(pages)) {
    if (!page.spaceId || (changedSpaces && !changedSpaces.has(page.spaceId))) continue
    add(page.spaceId, { kind: 'page', viewId: page.viewId, url: page.url, title: page.title, activityAt: page.lastActivityAt })
  }
  return work
}

/**
 * Keeps the canvas tabs in line with the AI's work; returns the stop function.
 * Called once from App. A pass that finds every tab in place changes nothing
 * and notifies no one.
 */
export function startAIWorkTabs(): () => void {
  const sync = (changedSpaces?: ReadonlySet<string>) => {
    if (changedSpaces?.size === 0) return
    canvasLifecycle.syncAIWork(collectAIWork(useTerminalStore.getState().sessions, useAIBrowserStore.getState().pages, changedSpaces), changedSpaces)
  }
  const offTerminal = useTerminalStore.subscribe((state, previous) => {
    if (state.sessions === previous.sessions) return
    const spaces = new Set<string>()
    for (const [id, session] of state.sessions) {
      const before = previous.sessions.get(id)
      if (session === before) continue
      if (session.title !== before?.title) canvasLifecycle.setTerminalTitle(id, session.title, session.spaceId)
      const live = session.state === 'running' && session.aiTouched ? session.spaceId : undefined
      const wasLive = before?.state === 'running' && before.aiTouched ? before.spaceId : undefined
      if (live !== wasLive) {
        if (live) spaces.add(live)
        if (wasLive) spaces.add(wasLive)
      }
    }
    for (const [id, session] of previous.sessions) {
      if (!state.sessions.has(id) && session.state === 'running' && session.aiTouched && session.spaceId) spaces.add(session.spaceId)
    }
    sync(spaces)
  })
  const offBrowser = useAIBrowserStore.subscribe((state, previous) => {
    if (state.pages === previous.pages) return
    const spaces = new Set<string>()
    for (const [id, page] of Object.entries(state.pages)) {
      const before = previous.pages[id]
      if (before === page) continue
      if (page.spaceId !== before?.spaceId) {
        if (page.spaceId) spaces.add(page.spaceId)
        if (before?.spaceId) spaces.add(before.spaceId)
      } else if (page.spaceId && before && (page.title !== before.title || page.url !== before.url)) {
        canvasLifecycle.updateAIPageMetadata(page.spaceId, id, page.url, page.title)
      }
    }
    for (const [id, page] of Object.entries(previous.pages)) {
      if (!state.pages[id] && page.spaceId) spaces.add(page.spaceId)
    }
    sync(spaces)
  })
  sync()
  return () => {
    offTerminal()
    offBrowser()
  }
}

/**
 * Whether this client can end what an AI tab runs. A remote web client holds
 * no browser pages, so it cannot close the AI's page; that tab stays until it
 * is closed on the computer.
 */
export function canEndOnThisClient(tab: Pick<TabState, 'aiWork' | 'type'>): boolean {
  return !(tab.aiWork && tab.type === 'browser' && !isElectron())
}
