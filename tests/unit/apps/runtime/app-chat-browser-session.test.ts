/**
 * A digital-human chat's browser across the turns of one engine session.
 *
 * The engine session (one Claude Code process) is reused between messages for
 * up to 30 minutes, and its in-process `ai-browser` tool server closes over the
 * BrowserContext it was built with. Whatever happens to the chat's pages between
 * turns, the next turn's browser calls reach THAT context — so the context the
 * chat holds must stay the one its session holds, and must stay usable, for as
 * long as the session can run a turn.
 *
 * Production sequence this guards (IM direct chat, 2026-10-16): turn 1
 * creates the session and opens pages; the turn ends and the pages close;
 * turn 2 reuses the session and every browser call fails with "Browser context
 * was released", with nothing recovering it until the session idles out.
 *
 * Chats go through the real app-chat-browser; the tool server is built the
 * way app-chat.ts builds it, once, and reused like the session reuses it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const states = new Map<string, { id: string; url: string; title: string; isLoading: boolean; deviceMode: 'pc' }>()
const destroyedListeners = new Set<(viewId: string) => void>()

vi.mock('../../../../src/main/services/browser-view.service', () => ({
  browserViewManager: {
    create: async (viewId: string, url: string) => {
      const state = { id: viewId, url, title: `Title ${viewId}`, isLoading: false, deviceMode: 'pc' as const }
      states.set(viewId, state)
      return state
    },
    getAllStates: () => [...states.values()],
    getState: (id: string) => states.get(id) ?? null,
    getWebContents: () => null,
    isRevealed: () => false,
    destroy: (id: string) => {
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

vi.mock('../../../../src/main/services/ai-browser/events', () => ({
  emitBrowserActiveView: () => {},
  emitBrowserViewGone: () => {},
  emitBrowserConversationReleased: () => {},
  onBrowserActiveView: () => () => {},
  onBrowserViewGone: () => () => {},
  onBrowserConversationReleased: () => () => {},
}))

type ToolResult = { isError?: boolean; content: Array<{ text?: string }> }
type Tool = { name: string; handler: (args: Record<string, unknown>) => Promise<ToolResult> }
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  tool: (name: string, _description: string, _schema: unknown, handler: Tool['handler']): Tool => ({ name, handler }),
  createSdkMcpServer: (options: { tools: Tool[] }) => options,
}))

const generating = new Set<string>()
vi.mock('../../../../src/main/apps/runtime/app-chat-live-turn', () => ({
  isAppChatConversationGenerating: (id: string) => generating.has(id),
}))

vi.mock('../../../../src/main/apps/manager', () => ({
  getAppManager: () => ({ getApp: () => ({ status: 'active', permissions: { granted: [], denied: [] }, spec: {} }) }),
}))

const { acquireChatBrowserContext, bindChatBrowserSession, endChatBrowserTurn, destroyAllChatBrowserContexts, hasChatBrowserContext } =
  await import('../../../../src/main/apps/runtime/app-chat-browser')
const { createAIBrowserMcpServer } = await import('../../../../src/main/services/ai-browser')

const IM_KEY = 'app-chat:dh1:wecom-bot:direct:user-1'
const LOCAL_KEY = 'app-chat:dh1:local:direct:11111111-1111-1111-1111-111111111111'

/** The engine session as the chat sees it: an identity, and what runs when it is retired. */
function fakeSession() {
  const retired = new Set<() => void>()
  return {
    lease: {
      session: {},
      onRetired(listener: () => void) {
        retired.add(listener)
        return () => retired.delete(listener)
      },
    } as unknown as Parameters<typeof bindChatBrowserSession>[1],
    retire() {
      for (const listener of [...retired]) listener()
    },
  }
}

/** The tool server a session is built with, bound once to the context of the turn that built it. */
function toolServerFor(ctx: Parameters<typeof createAIBrowserMcpServer>[0]) {
  const server = createAIBrowserMcpServer(ctx, '/work') as unknown as { tools: Tool[] }
  const tool = (name: string) => server.tools.find((candidate) => candidate.name === name)!
  return {
    navigate: (url: string) => tool('browser_navigate').handler({ url }),
    listTabs: () => tool('browser_tab').handler({ action: 'list' }),
  }
}

const text = (result: ToolResult) => result.content.map((item) => item.text ?? '').join('\n')

describe('a chat’s browser across the turns of one engine session', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    states.clear()
    generating.clear()
  })

  afterEach(() => {
    destroyAllChatBrowserContexts('test-cleanup')
    vi.restoreAllMocks()
  })

  it('an IM chat can still open pages on its second turn, after the first turn’s pages were closed', async () => {
    // Turn 1 builds the session, and with it the tool server, from this context.
    const ctx = acquireChatBrowserContext(IM_KEY, 'dh1', 'space-1')
    const engine = fakeSession()
    bindChatBrowserSession(IM_KEY, engine.lease)
    const tools = toolServerFor(ctx)
    expect((await tools.navigate('https://example.com/first')).isError).toBeUndefined()
    endChatBrowserTurn(IM_KEY)
    // Unattended: nothing to watch, so the pages do not outlive the turn.
    expect(states.size).toBe(0)

    // Turn 2 reuses the session; its browser calls reach the server built in turn 1.
    expect(acquireChatBrowserContext(IM_KEY, 'dh1', 'space-1')).toBe(ctx)
    bindChatBrowserSession(IM_KEY, engine.lease)
    const second = await tools.navigate('https://example.com/second')

    expect(second.isError).toBeUndefined()
    expect(text(second)).not.toContain('released')
    expect(states.size).toBe(1)
    expect(text(await tools.listTabs())).toContain('https://example.com/second')
    endChatBrowserTurn(IM_KEY)
    expect(states.size).toBe(0)
  })

  it('an IM chat’s context ends with its session, not with its turn', () => {
    acquireChatBrowserContext(IM_KEY, 'dh1', 'space-1')
    const engine = fakeSession()
    bindChatBrowserSession(IM_KEY, engine.lease)
    endChatBrowserTurn(IM_KEY)
    expect(hasChatBrowserContext(IM_KEY)).toBe(true)

    engine.retire()

    expect(hasChatBrowserContext(IM_KEY)).toBe(false)
  })

  it('a session retired under a running turn leaves the turn its context; the next session is built from it', async () => {
    const ctx = acquireChatBrowserContext(IM_KEY, 'dh1', 'space-1')
    const first = fakeSession()
    bindChatBrowserSession(IM_KEY, first.lease)
    endChatBrowserTurn(IM_KEY)

    // Turn 2 acquires, then finds the session needs rebuilding: the old one is
    // retired while this turn is in flight, and a new one is built from `ctx`.
    expect(acquireChatBrowserContext(IM_KEY, 'dh1', 'space-1')).toBe(ctx)
    first.retire()
    expect(hasChatBrowserContext(IM_KEY)).toBe(true)
    const second = fakeSession()
    bindChatBrowserSession(IM_KEY, second.lease)
    const tools = toolServerFor(ctx)
    expect((await tools.navigate('https://example.com/rebuilt')).isError).toBeUndefined()
    endChatBrowserTurn(IM_KEY)

    // Only the session it now belongs to ends it.
    expect(hasChatBrowserContext(IM_KEY)).toBe(true)
    second.retire()
    expect(hasChatBrowserContext(IM_KEY)).toBe(false)
  })

  it('a native chat keeps its pages when its session is rebuilt, and the rebuilt session drives the same pages', async () => {
    const ctx = acquireChatBrowserContext(LOCAL_KEY, 'dh1', 'space-1')
    const first = fakeSession()
    bindChatBrowserSession(LOCAL_KEY, first.lease)
    const tools = toolServerFor(ctx)
    expect((await tools.navigate('https://example.com/kept')).isError).toBeUndefined()
    endChatBrowserTurn(LOCAL_KEY)

    // A config-change restart closes the idle session; the user may be watching the page.
    first.retire()
    expect(hasChatBrowserContext(LOCAL_KEY)).toBe(true)
    expect(states.size).toBe(1)

    expect(acquireChatBrowserContext(LOCAL_KEY, 'dh1', 'space-1')).toBe(ctx)
    bindChatBrowserSession(LOCAL_KEY, fakeSession().lease)
    expect(text(await toolServerFor(ctx).listTabs())).toContain('https://example.com/kept')
    endChatBrowserTurn(LOCAL_KEY)
  })
})
