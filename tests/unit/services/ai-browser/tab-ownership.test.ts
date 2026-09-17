/**
 * Who may see and touch which browser tab.
 *
 * Tabs live in one process-wide manager. Before this boundary existed every
 * agent enumerated that manager directly, which meant a digital human could
 * list a colleague's logged-in pages and navigate a tab another agent — or the
 * user — was working on, with nothing reported to the side that lost its page.
 *
 * The rule under test: an automation sees only what it opened; the user's own
 * browser sees the user's tabs and never an automation's.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const states = new Map<string, { id: string; url: string; title: string }>()

/**
 * WebContents ids handed out per view, so download routing can be asserted.
 * Only the surface `trackView` touches is faked — everything it does beyond
 * registering the route (muting, the anti-detection startup script) is
 * irrelevant here and is allowed to no-op.
 */
const webContentsOf = new Map<string, ReturnType<typeof makeWebContents>>()
let nextWcId = 1

function makeWebContents() {
  return {
    id: nextWcId++,
    isDestroyed: () => false,
    setAudioMuted: () => {},
    executeJavaScript: async () => undefined,
    on: () => {},
    once: () => {},
    removeListener: () => {},
    debugger: {
      isAttached: () => true,
      attach: () => {},
      sendCommand: async () => ({}),
    },
  }
}

vi.mock('../../../../src/main/services/browser-view.service', () => ({
  browserViewManager: {
    getAllStates: () => [...states.values()],
    getState: (id: string) => states.get(id) ?? null,
    getWebContents: (id: string) => webContentsOf.get(id) ?? null,
    destroy: (id: string) => { states.delete(id); webContentsOf.delete(id) },
  },
}))

const downloadRoutes = new Set<number>()
vi.mock('../../../../src/main/services/ai-browser/download-handler', () => ({
  registerWebContentsForDownload: (wcId: number) => { downloadRoutes.add(wcId) },
  unregisterWebContentsForDownload: (wcId: number) => { downloadRoutes.delete(wcId) },
}))

const viewGone: string[] = []
vi.mock('../../../../src/main/services/ai-browser/events', () => ({
  emitBrowserActiveView: vi.fn(),
  emitBrowserViewGone: ({ viewId }: { viewId: string }) => { viewGone.push(viewId) },
}))

vi.mock('../../../../src/main/services/ai-browser/snapshot', () => ({
  createAccessibilitySnapshot: vi.fn(),
  getElementBoundingBox: vi.fn(),
  scrollIntoView: vi.fn(),
  focusElement: vi.fn(),
}))
const {
  browserContext,
  createScopedBrowserContext,
  getInteractiveBrowserContext,
  releaseInteractiveBrowserContext,
  notifyViewDestroyed,
} = await import('../../../../src/main/services/ai-browser/context')

function openTab(id: string): void {
  states.set(id, { id, url: `https://example.com/${id}`, title: id })
  webContentsOf.set(id, makeWebContents())
}

/** The webContents id a tab was given, for asserting download routing. */
const wcIdOf = (viewId: string): number => webContentsOf.get(viewId)!.id

const idsOf = (ctx: { visibleViewStates: () => Array<{ id: string }> }): string[] =>
  ctx.visibleViewStates().map((s) => s.id).sort()

describe('browser tab ownership', () => {
  beforeEach(() => {
    states.clear()
  })

  it('shows an automation only the tabs it opened itself', () => {
    const alice = createScopedBrowserContext()
    const bob = createScopedBrowserContext()

    openTab('alice-1')
    alice.trackView('alice-1')
    openTab('bob-1')
    bob.trackView('bob-1')

    expect(idsOf(alice)).toEqual(['alice-1'])
    expect(idsOf(bob)).toEqual(['bob-1'])
  })

  it('refuses to let one automation act on another’s tab', () => {
    const alice = createScopedBrowserContext()
    const bob = createScopedBrowserContext()
    openTab('alice-1')
    alice.trackView('alice-1')
    openTab('bob-1')
    bob.trackView('bob-1')

    // The reported incident: an agent selected a page a teammate was on and
    // navigated it away, and the teammate's next read silently returned the
    // wrong page.
    expect(bob.canReachView('alice-1')).toBe(false)
    expect(alice.canReachView('bob-1')).toBe(false)
    expect(alice.canReachView('alice-1')).toBe(true)
  })

  it('hides automation tabs from the user’s own browser, and keeps the user’s own', () => {
    const agent = createScopedBrowserContext()
    openTab('user-tab')
    openTab('agent-tab')
    agent.trackView('agent-tab')

    // The user's browser never created 'user-tab' through a context (the canvas
    // opens it directly), so unclaimed tabs must stay visible to the human side.
    expect(idsOf(browserContext)).toEqual(['user-tab'])
    expect(browserContext.canReachView('agent-tab')).toBe(false)
  })

  it('returns a tab to the user’s browser once its automation is gone', () => {
    const agent = createScopedBrowserContext()
    openTab('agent-tab')
    agent.trackView('agent-tab')
    expect(browserContext.canReachView('agent-tab')).toBe(false)

    // destroy() removes the view; a later view reusing the id must not inherit
    // a stale claim, which is what a leaked ownership set would cause.
    agent.destroy()
    openTab('agent-tab')
    expect(browserContext.canReachView('agent-tab')).toBe(true)
  })
})

describe('one active tab per conversation, one shared set of tabs', () => {
  beforeEach(() => {
    states.clear()
    releaseInteractiveBrowserContext('chat-a')
    releaseInteractiveBrowserContext('chat-b')
  })

  it('keeps each conversation’s active tab to itself', () => {
    const a = getInteractiveBrowserContext('chat-a')
    const b = getInteractiveBrowserContext('chat-b')
    openTab('tab-1')
    openTab('tab-2')

    a.setActiveViewId('tab-1')
    b.setActiveViewId('tab-2')

    // The reported failure: one shared pointer meant B's next call landed on
    // whatever A had navigated to, with no select and no error.
    expect(a.getActiveViewId()).toBe('tab-1')
    expect(b.getActiveViewId()).toBe('tab-2')
  })

  it('still lets both conversations see the user’s tabs', () => {
    const a = getInteractiveBrowserContext('chat-a')
    const b = getInteractiveBrowserContext('chat-b')
    openTab('user-tab')

    // Splitting the pointer must not wall a conversation off from the browser
    // the user actually has open — answering about that page is the point.
    expect(idsOf(a)).toEqual(['user-tab'])
    expect(idsOf(b)).toEqual(['user-tab'])
  })

  it('returns the same context for the same conversation', () => {
    expect(getInteractiveBrowserContext('chat-a')).toBe(getInteractiveBrowserContext('chat-a'))
  })

  it('leaves the user’s tabs open when a conversation ends', () => {
    const a = getInteractiveBrowserContext('chat-a')
    openTab('user-tab')
    a.trackView('user-tab')

    releaseInteractiveBrowserContext('chat-a')

    // Destroying instead of releasing here would close tabs the user is looking
    // at the moment they close a chat.
    expect(states.has('user-tab')).toBe(true)
    expect(browserContext.canReachView('user-tab')).toBe(true)
  })
})

describe('a tab closed by someone else', () => {
  beforeEach(() => {
    states.clear()
    webContentsOf.clear()
    downloadRoutes.clear()
    viewGone.length = 0
    releaseInteractiveBrowserContext('chat-a')
    releaseInteractiveBrowserContext('chat-b')
  })

  it('clears the pointer in EVERY conversation holding it, not just one', () => {
    const a = getInteractiveBrowserContext('chat-a')
    const b = getInteractiveBrowserContext('chat-b')
    openTab('shared-tab')
    a.setActiveViewId('shared-tab')
    b.setActiveViewId('shared-tab')

    // The user closes it from the canvas. Reconciling only the context the
    // closer happens to know about leaves the others pointing at a dead page,
    // so their next navigation fails instead of opening a fresh one.
    notifyViewDestroyed('shared-tab')

    expect(a.getActiveViewId()).toBeNull()
    expect(b.getActiveViewId()).toBeNull()
  })

  it('tells the renderer once, however many conversations were on it', () => {
    const a = getInteractiveBrowserContext('chat-a')
    const b = getInteractiveBrowserContext('chat-b')
    openTab('shared-tab')
    a.setActiveViewId('shared-tab')
    b.setActiveViewId('shared-tab')

    notifyViewDestroyed('shared-tab')

    expect(viewGone).toEqual(['shared-tab'])
  })

  it('says nothing to the renderer for an automation’s offscreen page', () => {
    const agent = createScopedBrowserContext()
    openTab('agent-tab')
    agent.trackView('agent-tab')
    agent.setActiveViewId('agent-tab')

    notifyViewDestroyed('agent-tab')

    // The renderer has no live-session entry for an offscreen automation page.
    expect(viewGone).toEqual([])
    expect(agent.getActiveViewId()).toBeNull()
  })

  it('releases the automation’s claim so the id is not poisoned for a later tab', () => {
    const agent = createScopedBrowserContext()
    openTab('recycled')
    agent.trackView('recycled')
    expect(browserContext.canReachView('recycled')).toBe(false)

    notifyViewDestroyed('recycled')
    openTab('recycled')

    expect(browserContext.canReachView('recycled')).toBe(true)
  })
})

describe('download routing follows the tab, not the conversation', () => {
  beforeEach(() => {
    states.clear()
    webContentsOf.clear()
    downloadRoutes.clear()
    releaseInteractiveBrowserContext('chat-a')
  })

  it('stops routing a surviving tab’s downloads once its conversation ends', () => {
    const a = getInteractiveBrowserContext('chat-a')
    openTab('user-tab')
    a.trackView('user-tab')
    expect(downloadRoutes.has(wcIdOf('user-tab'))).toBe(true)

    releaseInteractiveBrowserContext('chat-a')

    // The tab outlives the conversation and looks like any other. Left
    // registered, the USER's own downloads from it would keep going silently to
    // the AI's download folder instead of where they expect.
    expect(states.has('user-tab')).toBe(true)
    expect(downloadRoutes.has(wcIdOf('user-tab'))).toBe(false)
  })

  it('still unroutes when an automation is destroyed with its tabs', () => {
    const agent = createScopedBrowserContext()
    openTab('agent-tab')
    agent.trackView('agent-tab')
    const wcId = wcIdOf('agent-tab')

    agent.destroy()

    expect(downloadRoutes.has(wcId)).toBe(false)
  })
})
