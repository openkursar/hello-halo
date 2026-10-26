/**
 * Who can watch a digital-human chat's browser pages, and how long they live.
 *
 * Native chats (default + local sessions) get a live view and keep their pages
 * between turns so the next message continues on the same page and the user can
 * open the live view; IM/HTTP/team sessions run unattended and their pages close
 * with the turn. Resident is bounded: idle pages are closed, the number of chats
 * holding pages is capped, and nothing is closed mid-turn or while the user is
 * watching a tab.
 *
 * The context itself outlives its pages: the engine session's browser tools
 * were built around it and serve every later turn of that session, so it goes
 * when the session is retired — or, when no session ever took it, with the sweep.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

interface FakeCtx {
  liveView: { conversationId: string; spaceId: string } | undefined
  ownedViewCount: number
  revealed: boolean
  destroyed: boolean
  pagesClosed: number
  closePages: () => void
  destroy: () => void
  hasRevealedView: () => boolean
}

const created: FakeCtx[] = []
vi.mock('../../../../src/main/services/ai-browser', () => ({
  createScopedBrowserContext: ({ liveView }: { liveView?: FakeCtx['liveView'] }): FakeCtx => {
    const ctx: FakeCtx = {
      liveView,
      ownedViewCount: 1,
      revealed: false,
      destroyed: false,
      pagesClosed: 0,
      closePages: () => { ctx.pagesClosed++; ctx.ownedViewCount = 0 },
      destroy: () => { ctx.destroyed = true; ctx.ownedViewCount = 0 },
      hasRevealedView: () => ctx.revealed,
    }
    created.push(ctx)
    return ctx
  },
}))

const generating = new Set<string>()
vi.mock('../../../../src/main/apps/runtime/app-chat-live-turn', () => ({
  isAppChatConversationGenerating: (id: string) => generating.has(id),
}))

const app = (status = 'active', denied: string[] = []) => ({ status, permissions: { granted: [] as string[], denied }, spec: {} })
const apps = new Map<string, ReturnType<typeof app>>()
vi.mock('../../../../src/main/apps/manager', () => ({
  getAppManager: () => ({ getApp: (id: string) => apps.get(id) ?? null }),
}))

const {
  acquireChatBrowserContext,
  bindChatBrowserSession,
  endChatBrowserTurn,
  destroyChatBrowserContext,
  destroyChatBrowserContextsForApp,
  destroyAllChatBrowserContexts,
  hasChatBrowserContext,
  getChatBrowserStats,
  sweepChatBrowserContexts,
  isResidentChatKey,
  RESIDENT_BROWSER_IDLE_MS,
  MAX_RESIDENT_BROWSER_CONTEXTS,
  TURN_TRUST_MS,
} = await import('../../../../src/main/apps/runtime/app-chat-browser')

const DEFAULT_KEY = 'app-chat:dh1'
const LOCAL_KEY = 'app-chat:dh1:local:direct:11111111-1111-1111-1111-111111111111'
const IM_KEY = 'app-chat:dh1:wecom-bot:direct:user-1'
const HTTP_KEY = 'app-chat:dh1:http:direct:client-1'
const TEAM_KEY = 'app-chat:dh1:team:t1:e1'

/** An engine session as the chat sees it: an identity, and listeners run when it is retired. */
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

/** A chat's turn start, with the engine session the turn runs on. */
function startTurn(key: string, session = fakeSession()): { ctx: FakeCtx; session: ReturnType<typeof fakeSession> } {
  const ctx = acquireChatBrowserContext(key, 'dh1', 'space-1') as unknown as FakeCtx
  bindChatBrowserSession(key, session.lease)
  return { ctx, session }
}

describe('app chat browser contexts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    created.length = 0
    generating.clear()
    apps.clear()
    apps.set('dh1', app())
    apps.set('dh2', app())
    destroyAllChatBrowserContexts('test-reset')
  })

  afterEach(() => {
    destroyAllChatBrowserContexts('test-cleanup')
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('who keeps pages between turns', () => {
    it('keeps them for the default session and the user’s local sessions', () => {
      expect(isResidentChatKey(DEFAULT_KEY, 'dh1')).toBe(true)
      expect(isResidentChatKey(LOCAL_KEY, 'dh1')).toBe(true)
    })

    it('closes them with the turn for IM, HTTP and team sessions', () => {
      expect(isResidentChatKey(IM_KEY, 'dh1')).toBe(false)
      expect(isResidentChatKey(HTTP_KEY, 'dh1')).toBe(false)
      expect(isResidentChatKey(TEAM_KEY, 'dh1')).toBe(false)
    })

    it('keeps a local session’s pages after the turn and reuses the same context next turn', () => {
      const { ctx, session } = startTurn(LOCAL_KEY)
      endChatBrowserTurn(LOCAL_KEY)

      expect(hasChatBrowserContext(LOCAL_KEY)).toBe(true)
      expect(ctx.pagesClosed).toBe(0)
      expect(startTurn(LOCAL_KEY, session).ctx).toBe(ctx)
      expect(created).toHaveLength(1)
    })

    it.each([IM_KEY, HTTP_KEY, TEAM_KEY])('closes %s’s pages when its turn ends and keeps the context for its session', (key) => {
      const { ctx, session } = startTurn(key)

      endChatBrowserTurn(key)

      expect(ctx.pagesClosed).toBe(1)
      expect(ctx.destroyed).toBe(false)
      expect(hasChatBrowserContext(key)).toBe(true)
      // The next turn on that session reaches the same object its tools were built around.
      expect(startTurn(key, session).ctx).toBe(ctx)
      expect(created).toHaveLength(1)
    })

    it('keeps a per-turn chat’s pages until the last of overlapping turns ends', () => {
      const { ctx, session } = startTurn(HTTP_KEY)
      expect(startTurn(HTTP_KEY, session).ctx).toBe(ctx)

      endChatBrowserTurn(HTTP_KEY)
      expect(ctx.pagesClosed).toBe(0)

      endChatBrowserTurn(HTTP_KEY)
      expect(ctx.pagesClosed).toBe(1)
    })

    it.each([DEFAULT_KEY, LOCAL_KEY])('lets the user watch %s’s pages, under its own key and space', (key) => {
      acquireChatBrowserContext(key, 'dh1', 'space-1')
      // The tray lists pages per space; without it they would show up nowhere.
      expect(created[0].liveView).toEqual({ conversationId: key, spaceId: 'space-1' })
    })

    it.each([IM_KEY, HTTP_KEY, TEAM_KEY])('runs %s unattended: no live view, so its pages stay out of the main window', (key) => {
      acquireChatBrowserContext(key, 'dh1', 'space-1')
      expect(created[0].liveView).toBeUndefined()
    })
  })

  describe('the context lives with its engine session', () => {
    it.each([IM_KEY, HTTP_KEY, TEAM_KEY])('disposes %s’s context when its session is retired between turns', (key) => {
      const { ctx, session } = startTurn(key)
      endChatBrowserTurn(key)

      session.retire()

      expect(ctx.destroyed).toBe(true)
      expect(hasChatBrowserContext(key)).toBe(false)
    })

    it('disposes a native chat’s context when its session is retired and it holds no pages', () => {
      const { ctx, session } = startTurn(DEFAULT_KEY)
      endChatBrowserTurn(DEFAULT_KEY)
      ctx.ownedViewCount = 0

      session.retire()

      expect(ctx.destroyed).toBe(true)
    })

    it('leaves a native chat’s pages when its session is retired (config-change restart), and the next session takes the same context', () => {
      const { ctx, session } = startTurn(DEFAULT_KEY)
      endChatBrowserTurn(DEFAULT_KEY)

      session.retire()

      expect(ctx.destroyed).toBe(false)
      expect(ctx.pagesClosed).toBe(0)
      expect(startTurn(DEFAULT_KEY).ctx).toBe(ctx)
    })

    it('does not dispose a context whose session is retired under a running turn; the turn re-binds it', () => {
      const { ctx, session: first } = startTurn(IM_KEY)
      endChatBrowserTurn(IM_KEY)
      acquireChatBrowserContext(IM_KEY, 'dh1', 'space-1')

      // The turn's session acquisition rebuilt the session: the old one is retired mid-turn.
      first.retire()
      expect(ctx.destroyed).toBe(false)
      const second = fakeSession()
      bindChatBrowserSession(IM_KEY, second.lease)
      endChatBrowserTurn(IM_KEY)
      expect(hasChatBrowserContext(IM_KEY)).toBe(true)

      second.retire()
      expect(ctx.destroyed).toBe(true)
    })

    it('ignores the retirement of a session the chat has already moved on from', () => {
      const { ctx, session: first } = startTurn(IM_KEY)
      const second = fakeSession()
      bindChatBrowserSession(IM_KEY, second.lease)
      endChatBrowserTurn(IM_KEY)

      first.retire()

      expect(ctx.destroyed).toBe(false)
      expect(hasChatBrowserContext(IM_KEY)).toBe(true)
    })

    it('binds the same session once', () => {
      const { session } = startTurn(IM_KEY)
      endChatBrowserTurn(IM_KEY)
      startTurn(IM_KEY, session)
      endChatBrowserTurn(IM_KEY)

      session.retire()

      expect(hasChatBrowserContext(IM_KEY)).toBe(false)
    })
  })

  describe('explicit teardown', () => {
    it('closes one chat’s pages (session deleted or cleared)', () => {
      const ctx = acquireChatBrowserContext(LOCAL_KEY, 'dh1', 'space-1') as unknown as FakeCtx
      expect(destroyChatBrowserContext(LOCAL_KEY, 'session-cleared')).toBe(true)
      expect(ctx.destroyed).toBe(true)
      expect(destroyChatBrowserContext(LOCAL_KEY, 'session-cleared')).toBe(false)
    })

    it('closes every chat of an uninstalled app and nobody else’s', () => {
      const a = acquireChatBrowserContext(DEFAULT_KEY, 'dh1', 'space-1') as unknown as FakeCtx
      const b = acquireChatBrowserContext(LOCAL_KEY, 'dh1', 'space-1') as unknown as FakeCtx
      const other = acquireChatBrowserContext('app-chat:dh2', 'dh2', 'space-1') as unknown as FakeCtx

      expect(destroyChatBrowserContextsForApp('dh1', 'app-uninstalled')).toBe(2)

      expect([a.destroyed, b.destroyed, other.destroyed]).toEqual([true, true, false])
    })

    it('closes everything on shutdown', () => {
      acquireChatBrowserContext(DEFAULT_KEY, 'dh1', 'space-1')
      acquireChatBrowserContext('app-chat:dh2', 'dh2', 'space-1')

      expect(destroyAllChatBrowserContexts('shutdown')).toBe(2)
      expect(getChatBrowserStats().contexts).toBe(0)
    })

    it('does not fail teardown when a context refuses to close', () => {
      const ctx = acquireChatBrowserContext(DEFAULT_KEY, 'dh1', 'space-1') as unknown as FakeCtx
      ctx.destroy = () => { throw new Error('view already gone') }
      vi.spyOn(console, 'error').mockImplementation(() => {})

      expect(destroyChatBrowserContext(DEFAULT_KEY, 'test')).toBe(true)
      expect(hasChatBrowserContext(DEFAULT_KEY)).toBe(false)
    })

    it('does not fail a turn’s end when a context refuses to close its pages', () => {
      const { ctx } = startTurn(IM_KEY)
      ctx.closePages = () => { throw new Error('view already gone') }
      vi.spyOn(console, 'error').mockImplementation(() => {})

      endChatBrowserTurn(IM_KEY)

      expect(hasChatBrowserContext(IM_KEY)).toBe(true)
    })
  })

  describe('idle reaping', () => {
    it('closes a resident chat’s pages left idle past the limit, keeping the context for its session', () => {
      const { ctx } = startTurn(LOCAL_KEY)
      endChatBrowserTurn(LOCAL_KEY)

      sweepChatBrowserContexts(Date.now() + RESIDENT_BROWSER_IDLE_MS - 1)
      expect(ctx.pagesClosed).toBe(0)

      sweepChatBrowserContexts(Date.now() + RESIDENT_BROWSER_IDLE_MS)
      expect(ctx.pagesClosed).toBe(1)
      expect(ctx.destroyed).toBe(false)
      expect(hasChatBrowserContext(LOCAL_KEY)).toBe(true)
    })

    it('disposes a resident context left idle past the limit when no session holds it', () => {
      const ctx = acquireChatBrowserContext(LOCAL_KEY, 'dh1', 'space-1') as unknown as FakeCtx
      endChatBrowserTurn(LOCAL_KEY)

      sweepChatBrowserContexts(Date.now() + RESIDENT_BROWSER_IDLE_MS)

      expect(ctx.destroyed).toBe(true)
      expect(hasChatBrowserContext(LOCAL_KEY)).toBe(false)
    })

    it('measures idleness from the last turn, not from creation', () => {
      acquireChatBrowserContext(LOCAL_KEY, 'dh1', 'space-1')
      endChatBrowserTurn(LOCAL_KEY)
      vi.advanceTimersByTime(RESIDENT_BROWSER_IDLE_MS - 1000)
      acquireChatBrowserContext(LOCAL_KEY, 'dh1', 'space-1')
      endChatBrowserTurn(LOCAL_KEY)

      sweepChatBrowserContexts(Date.now() + RESIDENT_BROWSER_IDLE_MS - 1)

      expect(hasChatBrowserContext(LOCAL_KEY)).toBe(true)
    })

    it('never reaps mid-turn', () => {
      acquireChatBrowserContext(LOCAL_KEY, 'dh1', 'space-1')
      generating.add(LOCAL_KEY)

      sweepChatBrowserContexts(Date.now() + RESIDENT_BROWSER_IDLE_MS * 10)

      expect(hasChatBrowserContext(LOCAL_KEY)).toBe(true)
    })

    it('never closes a page the user is watching', () => {
      const ctx = acquireChatBrowserContext(LOCAL_KEY, 'dh1', 'space-1') as unknown as FakeCtx
      endChatBrowserTurn(LOCAL_KEY)
      ctx.revealed = true

      sweepChatBrowserContexts(Date.now() + RESIDENT_BROWSER_IDLE_MS * 10)
      expect(ctx.destroyed).toBe(false)

      ctx.revealed = false
      sweepChatBrowserContexts(Date.now() + RESIDENT_BROWSER_IDLE_MS * 10)
      expect(ctx.destroyed).toBe(true)
    })

    it('closes the pages of an app whose browser permission was revoked, without waiting for its next turn', () => {
      const { ctx } = startTurn(DEFAULT_KEY)
      endChatBrowserTurn(DEFAULT_KEY)
      apps.set('dh1', app('active', ['ai-browser']))

      sweepChatBrowserContexts()

      expect(ctx.pagesClosed).toBe(1)
      expect(ctx.destroyed).toBe(false)
    })

    it('does not close a revoked app’s pages while a turn is running or its tab is watched', () => {
      const ctx = acquireChatBrowserContext(DEFAULT_KEY, 'dh1', 'space-1') as unknown as FakeCtx
      endChatBrowserTurn(DEFAULT_KEY)
      apps.set('dh1', app('active', ['ai-browser']))
      generating.add(DEFAULT_KEY)
      sweepChatBrowserContexts()
      generating.clear()
      ctx.revealed = true
      sweepChatBrowserContexts()

      expect(ctx.destroyed).toBe(false)
      expect(ctx.pagesClosed).toBe(0)
    })

    it('notices an app that vanished without an uninstall event (space deleted)', () => {
      const { ctx } = startTurn(DEFAULT_KEY)
      endChatBrowserTurn(DEFAULT_KEY)
      apps.delete('dh1')

      sweepChatBrowserContexts()

      expect(ctx.destroyed).toBe(true)
    })

    it('notices an uninstalled app', () => {
      const { ctx } = startTurn(DEFAULT_KEY)
      endChatBrowserTurn(DEFAULT_KEY)
      apps.set('dh1', app('uninstalled'))

      sweepChatBrowserContexts()

      expect(ctx.destroyed).toBe(true)
    })

    it('reclaims a per-turn context whose turn never reported back and no session took', () => {
      const ctx = acquireChatBrowserContext(IM_KEY, 'dh1', 'space-1') as unknown as FakeCtx

      sweepChatBrowserContexts(Date.now() + 60_000)
      expect(ctx.destroyed).toBe(false)

      sweepChatBrowserContexts(Date.now() + 10 * 60_000)
      expect(ctx.destroyed).toBe(true)
    })

    it('disposes a per-turn context no session took as soon as its turn ends (turn refused while being set up)', () => {
      const ctx = acquireChatBrowserContext(IM_KEY, 'dh1', 'space-1') as unknown as FakeCtx

      endChatBrowserTurn(IM_KEY)

      expect(ctx.destroyed).toBe(true)
      expect(hasChatBrowserContext(IM_KEY)).toBe(false)
    })

    it('disposes a per-turn context whose session was retired under its turn when that turn ends', () => {
      const { ctx, session } = startTurn(IM_KEY)

      session.retire()
      expect(ctx.destroyed).toBe(false)
      endChatBrowserTurn(IM_KEY)

      expect(ctx.destroyed).toBe(true)
      expect(hasChatBrowserContext(IM_KEY)).toBe(false)
    })

    it('only closes the pages of a per-turn context whose turn never reported back when a session holds it', () => {
      const { ctx } = startTurn(IM_KEY)

      sweepChatBrowserContexts(Date.now() + 10 * 60_000)

      expect(ctx.pagesClosed).toBe(1)
      expect(ctx.destroyed).toBe(false)
      expect(hasChatBrowserContext(IM_KEY)).toBe(true)
    })

    it('runs on its own timer while contexts exist', () => {
      const ctx = acquireChatBrowserContext(LOCAL_KEY, 'dh1', 'space-1') as unknown as FakeCtx
      endChatBrowserTurn(LOCAL_KEY)

      vi.advanceTimersByTime(RESIDENT_BROWSER_IDLE_MS + 60_000)

      expect(ctx.destroyed).toBe(true)
      // Timer stops with the last context: nothing left to keep polling for.
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  describe('capacity', () => {
    function fillToCap(): string[] {
      const keys: string[] = []
      for (let i = 0; i < MAX_RESIDENT_BROWSER_CONTEXTS; i++) {
        const key = `app-chat:dh1:local:direct:s${i}`
        startTurn(key)
        endChatBrowserTurn(key)
        vi.advanceTimersByTime(1000)
        keys.push(key)
      }
      return keys
    }

    const holdsPages = (index: number) => created[index].ownedViewCount > 0

    it('makes room for a new chat by closing the pages of the least recently used idle one', () => {
      const keys = fillToCap()

      acquireChatBrowserContext('app-chat:dh1:local:direct:new', 'dh1', 'space-1')

      expect(holdsPages(0)).toBe(false)
      expect(created[0].destroyed).toBe(false)
      expect(keys.slice(1).map((_, i) => holdsPages(i + 1))).toEqual([true, true, true, true, true])
      expect(hasChatBrowserContext('app-chat:dh1:local:direct:new')).toBe(true)
    })

    it('skips a chat that is mid-turn or watched, even if it is the oldest', () => {
      const keys = fillToCap()
      generating.add(keys[0])
      created[1].revealed = true

      acquireChatBrowserContext('app-chat:dh1:local:direct:new', 'dh1', 'space-1')

      expect(holdsPages(0)).toBe(true)
      expect(holdsPages(1)).toBe(true)
      expect(holdsPages(2)).toBe(false)
    })

    it('never evicts a chat that only just acquired its context and has not registered a turn yet', () => {
      const keys = fillToCap()
      // The oldest chat starts a turn: acquired, session still building, not yet "generating".
      acquireChatBrowserContext(keys[0], 'dh1', 'space-1')

      acquireChatBrowserContext('app-chat:dh1:local:direct:new', 'dh1', 'space-1')

      expect(holdsPages(0)).toBe(true)
      expect(holdsPages(1)).toBe(false)
    })

    it('still protects a starting turn whose session takes longer than a minute to build', () => {
      const keys = fillToCap()
      acquireChatBrowserContext(keys[0], 'dh1', 'space-1')
      vi.advanceTimersByTime(3 * 60_000)
      // The others were used since, so the starting turn's context is the least recently used.
      keys.slice(1).forEach((k) => { acquireChatBrowserContext(k, 'dh1', 'space-1'); endChatBrowserTurn(k) })

      acquireChatBrowserContext('app-chat:dh1:local:direct:new', 'dh1', 'space-1')

      expect(holdsPages(0)).toBe(true)
      expect(holdsPages(1)).toBe(false)
    })

    it('stops trusting a turn that acquired its context and never reported back', () => {
      const keys = fillToCap()
      acquireChatBrowserContext(keys[0], 'dh1', 'space-1')
      vi.advanceTimersByTime(TURN_TRUST_MS)
      // Keep the others more recent so keys[0] is the one to go.
      keys.slice(1).forEach((k) => { acquireChatBrowserContext(k, 'dh1', 'space-1'); endChatBrowserTurn(k) })

      acquireChatBrowserContext('app-chat:dh1:local:direct:new', 'dh1', 'space-1')

      expect(holdsPages(0)).toBe(false)
    })

    it('goes over the cap rather than kill a live turn', () => {
      const keys = fillToCap()
      keys.forEach((k) => generating.add(k))

      acquireChatBrowserContext('app-chat:dh1:local:direct:new', 'dh1', 'space-1')

      expect(getChatBrowserStats().contexts).toBe(MAX_RESIDENT_BROWSER_CONTEXTS + 1)
      expect(console.warn).toHaveBeenCalled()
    })

    it('does not count a context that holds no pages', () => {
      fillToCap()
      created.forEach((c) => { c.ownedViewCount = 0 })

      acquireChatBrowserContext('app-chat:dh1:local:direct:new', 'dh1', 'space-1')

      expect(created.every((c) => c.pagesClosed === 0)).toBe(true)
    })
  })
})
