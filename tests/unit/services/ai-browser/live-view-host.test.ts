/**
 * Where a digital human's browser pages open, and whether the renderer hears of
 * them.
 *
 * Only whether someone can watch decides it. A native chat and a run started
 * with the desktop's Run once open pages in the main window and announce them
 * (live view, tray). IM, team and HTTP chats and every other run keep their
 * pages in the hidden host and say nothing: they run while nobody is at the
 * computer — when the main window failed to attach every new page — and an
 * announced page there would offer a live view that cannot open.
 *
 * A page someone could watch that the main window cannot attach in time opens
 * in the hidden host instead, and from then on is treated like an unattended
 * one, without silencing the rest of its chat.
 *
 * Chats go through the real app-chat-browser; runs pass exactly what execute.ts
 * passes. Pages are opened by the real browser tools.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { BrowserContext } from '../../../../src/main/services/ai-browser/context'

const states = new Map<string, { id: string; url: string; title: string; isLoading: boolean; deviceMode: 'pc' }>()
const created: Array<{ viewId: string; offscreen: boolean | undefined }> = []
const destroyedListeners = new Set<(viewId: string) => void>()
/** What creating a page in the main window fails with, when set. */
let mainHostFailure: Error | null = null
/** Page contents, given to pages only while a test looks at what is applied to them. */
const contents = new Map<string, ReturnType<typeof fakeContents>>()
let withContents = false

function fakeContents(id: number) {
  return {
    id,
    isDestroyed: () => false,
    getURL: () => '',
    setAudioMuted: vi.fn(),
    executeJavaScript: vi.fn(async (_source: string) => undefined),
    debugger: {
      attach: () => {},
      detach: () => {},
      on: () => {},
      off: () => {},
      sendCommand: vi.fn(async (_method: string, _params?: { source?: string }) => ({})),
    },
  }
}

vi.mock('../../../../src/main/services/browser-view.service', () => ({
  browserViewManager: {
    create: async (viewId: string, url: string, options?: { offscreen?: boolean }) => {
      created.push({ viewId, offscreen: options?.offscreen })
      if (!options?.offscreen && mainHostFailure) {
        // The real manager closes a page it failed to create, which reaches every context.
        for (const listener of destroyedListeners) listener(viewId)
        throw mainHostFailure
      }
      const state = { id: viewId, url, title: `Title ${viewId}`, isLoading: false, deviceMode: 'pc' as const }
      states.set(viewId, state)
      if (withContents) contents.set(viewId, fakeContents(contents.size + 1))
      return state
    },
    getAllStates: () => [...states.values()],
    getState: (id: string) => states.get(id) ?? null,
    getWebContents: (id: string) => contents.get(id) ?? null,
    isRevealed: () => false,
    destroy: (id: string) => {
      contents.delete(id)
      if (!states.delete(id)) return
      for (const listener of destroyedListeners) listener(id)
    },
    onViewDestroyed: (listener: (viewId: string) => void) => {
      destroyedListeners.add(listener)
      return () => destroyedListeners.delete(listener)
    },
  },
}))

vi.mock('../../../../src/main/services/ai-browser/download-handler', () => ({
  installDownloadHandler: () => {},
  registerWebContentsForDownload: () => {},
  unregisterWebContentsForDownload: () => {},
}))

const announced: string[] = []
vi.mock('../../../../src/main/services/ai-browser/events', () => ({
  emitBrowserActiveView: ({ conversationId, viewId }: { conversationId: string | null; viewId: string }) => {
    announced.push(`active-view ${conversationId} ${viewId}`)
  },
  emitBrowserViewGone: ({ viewId }: { viewId: string }) => { announced.push(`view-gone ${viewId}`) },
  emitBrowserConversationReleased: ({ conversationId }: { conversationId: string }) => {
    announced.push(`conversation-released ${conversationId}`)
  },
  onBrowserActiveView: () => () => {},
  onBrowserViewGone: () => () => {},
  onBrowserConversationReleased: () => () => {},
}))

type ToolResult = { isError?: boolean; content: Array<{ text?: string }> }
type Tool = { name: string; handler: (args: Record<string, unknown>) => Promise<ToolResult> }
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  tool: (name: string, _description: string, _schema: unknown, handler: Tool['handler']): Tool => ({ name, handler }),
  createSdkMcpServer: (options: unknown) => options,
}))

vi.mock('../../../../src/main/apps/runtime/app-chat-live-turn', () => ({
  isAppChatConversationGenerating: () => false,
}))

vi.mock('../../../../src/main/apps/manager', () => ({
  getAppManager: () => ({ getApp: () => ({ status: 'active', permissions: { granted: [], denied: [] }, spec: {} }) }),
}))

const { acquireChatBrowserContext, endChatBrowserTurn, destroyAllChatBrowserContexts } =
  await import('../../../../src/main/apps/runtime/app-chat-browser')
const {
  createScopedBrowserContext,
  getInteractiveBrowserContext,
  releaseInteractiveBrowserContext,
  listLivePages,
  stopLivePage,
} = await import('../../../../src/main/services/ai-browser/context')
const { buildNavigationTools } = await import('../../../../src/main/services/ai-browser/tools/navigation')
const { buildTabTools } = await import('../../../../src/main/services/ai-browser/tools/tab')
const { browserHostManager, MainHostAttachError } = await import('../../../../src/main/services/browser-host')

const DEFAULT_KEY = 'app-chat:dh1'
const LOCAL_KEY = 'app-chat:dh1:local:direct:11111111-1111-1111-1111-111111111111'
const IM_KEY = 'app-chat:dh1:wecom-bot:direct:user-1'
const TEAM_KEY = 'app-chat:dh1:team:t1:e1'
const HTTP_KEY = 'app-chat:dh1:http:direct:client-1'
const RUN_KEY = 'app-run:dh1:run-1'

function toolOf(tools: unknown[], name: string): Tool {
  return (tools as Tool[]).find((candidate) => candidate.name === name)!
}

/** Open a page the way the AI does, and return the view it now acts on. */
async function navigate(ctx: BrowserContext, url: string): Promise<string> {
  const result = await toolOf(buildNavigationTools(ctx), 'browser_navigate').handler({ url })
  expect(result.isError).toBeUndefined()
  return ctx.getActiveViewId()!
}

async function openTab(ctx: BrowserContext, url: string): Promise<string> {
  const result = await toolOf(buildTabTools(ctx), 'browser_tab').handler({ action: 'new', url })
  expect(result.isError).toBeUndefined()
  return ctx.getActiveViewId()!
}

/** What the model is told when a new tab is opened. */
async function openTabText(ctx: BrowserContext, url: string): Promise<string> {
  const result = await toolOf(buildTabTools(ctx), 'browser_tab').handler({ action: 'new', url })
  expect(result.isError).toBeUndefined()
  return result.content.map((item) => item.text ?? '').join('\n')
}

describe('who can watch a digital human’s browser pages', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    states.clear()
    created.length = 0
    announced.length = 0
  })

  afterEach(() => {
    destroyAllChatBrowserContexts('test-cleanup')
    releaseInteractiveBrowserContext('space-chat')
    vi.restoreAllMocks()
  })

  it.each([DEFAULT_KEY, LOCAL_KEY])('a native chat (%s) opens its pages in the main window and announces them', async (key) => {
    const ctx = acquireChatBrowserContext(key, 'dh1', 'space-1')
    const viewId = await navigate(ctx, 'https://example.com/native')

    expect(created).toEqual([{ viewId, offscreen: false }])
    expect(announced).toEqual([`active-view ${key} ${viewId}`])
    expect(listLivePages()).toEqual([expect.objectContaining({ conversationId: key, spaceId: 'space-1', viewId, owned: true, active: true })])

    // Resident: the turn ending leaves the page open for the user to watch.
    endChatBrowserTurn(key)
    expect(states.has(viewId)).toBe(true)
  })

  it.each([IM_KEY, TEAM_KEY, HTTP_KEY])('an unattended chat (%s) keeps its pages in the hidden host and says nothing', async (key) => {
    const ctx = acquireChatBrowserContext(key, 'dh1', 'space-1')
    const first = await navigate(ctx, 'https://example.com/first')
    const second = await openTab(ctx, 'https://example.com/second')

    expect(created).toEqual([{ viewId: first, offscreen: true }, { viewId: second, offscreen: true }])
    expect(listLivePages()).toEqual([])
    // Nothing the tray could have listed, so nothing it may stop in this chat's name.
    expect(stopLivePage(second, key)).toEqual({ stopped: false, reason: 'not-owned' })

    endChatBrowserTurn(key)

    expect(states.size).toBe(0)
    expect(announced).toEqual([])
  })

  it('a run started with the desktop’s Run once opens its pages where the user can watch them', async () => {
    const ctx = createScopedBrowserContext({ liveView: { conversationId: RUN_KEY, spaceId: 'space-1' } })
    const viewId = await navigate(ctx, 'https://example.com/run-once')

    expect(created).toEqual([{ viewId, offscreen: false }])
    expect(announced).toEqual([`active-view ${RUN_KEY} ${viewId}`])

    ctx.destroy()
    expect(announced.slice(1)).toEqual([`view-gone ${viewId}`, `conversation-released ${RUN_KEY}`])
  })

  it('every other run keeps its pages in the hidden host and says nothing', async () => {
    const ctx = createScopedBrowserContext(undefined)
    const viewId = await navigate(ctx, 'https://example.com/scheduled')

    expect(created).toEqual([{ viewId, offscreen: true }])
    expect(listLivePages()).toEqual([])

    ctx.destroy()
    expect(states.size).toBe(0)
    expect(announced).toEqual([])
  })

  it('a space chat still opens its pages where the user can watch them', async () => {
    const ctx = getInteractiveBrowserContext('space-chat', 'space-1')
    const viewId = await navigate(ctx, 'https://example.com/space-chat')

    expect(created).toEqual([{ viewId, offscreen: false }])
    expect(announced).toEqual([`active-view space-chat ${viewId}`])
  })
})

// A native chat woken while nobody is at the computer must still open pages,
// as it did when every digital-human page lived in the hidden window.
describe('when the main window cannot attach a page someone could watch', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    states.clear()
    created.length = 0
    announced.length = 0
    mainHostFailure = null
  })

  afterEach(() => {
    mainHostFailure = null
    destroyAllChatBrowserContexts('test-cleanup')
    releaseInteractiveBrowserContext('space-a')
    releaseInteractiveBrowserContext('space-b')
    vi.restoreAllMocks()
  })

  it('opens it in the hidden host within the same call, says so, and keeps it out of every live view', async () => {
    const ctx = acquireChatBrowserContext(DEFAULT_KEY, 'dh1', 'space-1')
    const watched = await navigate(ctx, 'https://example.com/watched')

    mainHostFailure = new MainHostAttachError('Browser guest attachment timed out')
    const text = await openTabText(ctx, 'https://example.com/unwatched')
    const unwatched = ctx.getActiveViewId()!

    expect(created.slice(1)).toEqual([{ viewId: unwatched, offscreen: false }, { viewId: unwatched, offscreen: true }])
    expect(states.has(unwatched)).toBe(true)
    expect(text).toContain('Created page')
    expect(text).toContain('cannot watch it live')
    // The page it could open earlier stays watchable; only the new one is silent.
    expect(announced).toEqual([`active-view ${DEFAULT_KEY} ${watched}`])
    expect(listLivePages().map((page) => page.viewId)).toEqual([watched])
    expect(stopLivePage(unwatched, DEFAULT_KEY)).toEqual({ stopped: false, reason: 'not-owned' })

    // Ending the chat closes both; only the page the renderer knew of is announced gone.
    destroyAllChatBrowserContexts('session-cleared')
    expect(states.size).toBe(0)
    expect(announced.slice(1)).toEqual([`view-gone ${watched}`, `conversation-released ${DEFAULT_KEY}`])
  })

  it('skips the main window while it has not recovered, so the wait is paid once', async () => {
    vi.spyOn(browserHostManager, 'isMainHostStalled').mockReturnValue(true)
    const ctx = acquireChatBrowserContext(LOCAL_KEY, 'dh1', 'space-1')

    const text = await openTabText(ctx, 'https://example.com/while-stalled')
    const viewId = ctx.getActiveViewId()!

    expect(created).toEqual([{ viewId, offscreen: true }])
    expect(text).toContain('cannot watch it live')
    expect(announced).toEqual([])
    expect(listLivePages()).toEqual([])
  })

  it('does not move a page that failed for any other reason', async () => {
    const ctx = acquireChatBrowserContext(DEFAULT_KEY, 'dh1', 'space-1')
    mainHostFailure = new Error('Browser page closed during creation')

    const result = await toolOf(buildNavigationTools(ctx), 'browser_navigate').handler({ url: 'https://example.com/closed' })

    expect(result.isError).toBe(true)
    expect(created).toHaveLength(1)
    expect(states.size).toBe(0)
  })

  it('an unattended chat has no main window to fall back from', async () => {
    const ctx = acquireChatBrowserContext(IM_KEY, 'dh1', 'space-1')
    mainHostFailure = new MainHostAttachError('Browser guest attachment timed out')

    const text = await openTabText(ctx, 'https://example.com/unattended')

    expect(created).toEqual([{ viewId: ctx.getActiveViewId(), offscreen: true }])
    expect(text).not.toContain('cannot watch it live')
  })

  it('a space chat’s background page stays silent whoever selects it, and closes with its chat', async () => {
    const owner = getInteractiveBrowserContext('space-a', 'space-1')
    const other = getInteractiveBrowserContext('space-b', 'space-1')
    mainHostFailure = new MainHostAttachError('Browser host is restarting')
    const unwatched = await navigate(owner, 'https://example.com/space-background')
    mainHostFailure = null

    const index = other.visibleViewStates().findIndex((state) => state.id === unwatched)
    const selected = await toolOf(buildTabTools(other), 'browser_tab').handler({ action: 'select', pageIdx: index })
    expect(selected.isError).toBeUndefined()
    expect(other.getActiveViewId()).toBe(unwatched)
    expect(announced).toEqual([])
    expect(listLivePages()).toEqual([])

    // A conversation's pages normally stay the user's; this one nobody could ever see.
    releaseInteractiveBrowserContext('space-a')
    expect(states.has(unwatched)).toBe(false)
    expect(other.getActiveViewId()).toBeNull()
    expect(announced).toEqual(['conversation-released space-a'])
  })
})

/** What was applied to keep a page quiet: mute calls, and the media/visibility script for new documents and for the current one. */
function silencing(viewId: string) {
  const page = contents.get(viewId)!
  const isSilencingScript = (source: string | undefined) =>
    !!source && source.includes("HTMLMediaElement.prototype, 'autoplay'") && source.includes("'visibilityState'")
  return {
    muted: page.setAudioMuted.mock.calls.map(([muted]) => muted),
    onNewDocument: page.debugger.sendCommand.mock.calls
      .filter(([method, params]) => method === 'Page.addScriptToEvaluateOnNewDocument' && isSilencingScript(params?.source)).length,
    onCurrentDocument: page.executeJavaScript.mock.calls.filter(([source]) => isSilencingScript(source)).length,
  }
}

// Nothing can show, list or stop such a page, so it is kept as quiet as every other hidden page.
describe('a page only the hidden host could take', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    states.clear()
    created.length = 0
    announced.length = 0
    contents.clear()
    withContents = true
    mainHostFailure = null
  })

  afterEach(() => {
    mainHostFailure = null
    destroyAllChatBrowserContexts('test-cleanup')
    releaseInteractiveBrowserContext('space-chat')
    withContents = false
    contents.clear()
    vi.restoreAllMocks()
  })

  const QUIET = { muted: [true], onNewDocument: 1, onCurrentDocument: 1 }

  it.each([
    ['a space chat', () => getInteractiveBrowserContext('space-chat', 'space-1')],
    ['a native chat', () => acquireChatBrowserContext(DEFAULT_KEY, 'dh1', 'space-1')],
  ])('is muted, blocks autoplay and reports itself visible in %s', async (_label, open) => {
    const ctx = open()
    await navigate(ctx, 'https://example.com/watched')
    mainHostFailure = new MainHostAttachError('Browser guest attachment timed out')

    const unwatched = await openTab(ctx, 'https://example.com/unwatched')

    expect(silencing(unwatched)).toEqual(QUIET)
  })

  it('is quiet when a space chat skips the main window while it recovers', async () => {
    vi.spyOn(browserHostManager, 'isMainHostStalled').mockReturnValue(true)
    const ctx = getInteractiveBrowserContext('space-chat', 'space-1')

    const viewId = await navigate(ctx, 'https://example.com/while-stalled')

    expect(silencing(viewId)).toEqual(QUIET)
  })

  it('leaves alone a space-chat page the user can watch', async () => {
    const ctx = getInteractiveBrowserContext('space-chat', 'space-1')

    const viewId = await navigate(ctx, 'https://example.com/watched')

    expect(silencing(viewId)).toEqual({ muted: [], onNewDocument: 0, onCurrentDocument: 0 })
  })
})
