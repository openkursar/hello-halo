/**
 * How long a digital-human chat's browser pages live.
 *
 * Native chats (default + local sessions) keep their context between turns so
 * the next message continues on the same page and the user can open the live
 * view; IM/HTTP/team sessions end with the turn. Resident is bounded: idle
 * contexts are reaped, the number holding pages is capped, and nothing is
 * reaped mid-turn or while the user is watching a tab.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

interface FakeCtx {
  conversationId: string
  spaceId: string
  ownedViewCount: number
  revealed: boolean
  destroyed: boolean
  destroy: () => void
  hasRevealedView: () => boolean
}

const created: FakeCtx[] = []
vi.mock('../../../../src/main/services/ai-browser', () => ({
  createScopedBrowserContext: ({ conversationId, spaceId }: { conversationId: string; spaceId: string }): FakeCtx => {
    const ctx: FakeCtx = {
      conversationId,
      spaceId,
      ownedViewCount: 1,
      revealed: false,
      destroyed: false,
      destroy: () => { ctx.destroyed = true },
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
  TURN_START_GRACE_MS,
} = await import('../../../../src/main/apps/runtime/app-chat-browser')

const DEFAULT_KEY = 'app-chat:dh1'
const LOCAL_KEY = 'app-chat:dh1:local:direct:11111111-1111-1111-1111-111111111111'
const IM_KEY = 'app-chat:dh1:wecom-bot:direct:user-1'
const HTTP_KEY = 'app-chat:dh1:http:direct:client-1'
const TEAM_KEY = 'app-chat:dh1:team:t1:e1'

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

  describe('who keeps a context between turns', () => {
    it('keeps it for the default session and the user’s local sessions', () => {
      expect(isResidentChatKey(DEFAULT_KEY, 'dh1')).toBe(true)
      expect(isResidentChatKey(LOCAL_KEY, 'dh1')).toBe(true)
    })

    it('ends it with the turn for IM, HTTP and team sessions', () => {
      expect(isResidentChatKey(IM_KEY, 'dh1')).toBe(false)
      expect(isResidentChatKey(HTTP_KEY, 'dh1')).toBe(false)
      expect(isResidentChatKey(TEAM_KEY, 'dh1')).toBe(false)
    })

    it('keeps a local session’s pages after the turn and reuses the same context next turn', () => {
      const first = acquireChatBrowserContext(LOCAL_KEY, 'dh1', 'space-1')
      endChatBrowserTurn(LOCAL_KEY)

      expect(hasChatBrowserContext(LOCAL_KEY)).toBe(true)
      expect((first as unknown as FakeCtx).destroyed).toBe(false)
      expect(acquireChatBrowserContext(LOCAL_KEY, 'dh1', 'space-1')).toBe(first)
      expect(created).toHaveLength(1)
    })

    it.each([IM_KEY, HTTP_KEY, TEAM_KEY])('destroys %s’s context when its turn ends', (key) => {
      const ctx = acquireChatBrowserContext(key, 'dh1', 'space-1') as unknown as FakeCtx

      endChatBrowserTurn(key)

      expect(ctx.destroyed).toBe(true)
      expect(hasChatBrowserContext(key)).toBe(false)
    })

    it('keeps a per-turn context alive until the last of overlapping turns ends', () => {
      const ctx = acquireChatBrowserContext(HTTP_KEY, 'dh1', 'space-1') as unknown as FakeCtx
      expect(acquireChatBrowserContext(HTTP_KEY, 'dh1', 'space-1')).toBe(ctx as never)

      endChatBrowserTurn(HTTP_KEY)
      expect(ctx.destroyed).toBe(false)

      endChatBrowserTurn(HTTP_KEY)
      expect(ctx.destroyed).toBe(true)
    })

    it('binds the context to its conversation so the renderer can tell whose page it is', () => {
      acquireChatBrowserContext(LOCAL_KEY, 'dh1', 'space-1')
      expect(created[0].conversationId).toBe(LOCAL_KEY)
      // The tray lists pages per space; without it they would show up nowhere.
      expect(created[0].spaceId).toBe('space-1')
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
  })

  describe('idle reaping', () => {
    it('reaps a resident context left idle past the limit', () => {
      const ctx = acquireChatBrowserContext(LOCAL_KEY, 'dh1', 'space-1') as unknown as FakeCtx
      endChatBrowserTurn(LOCAL_KEY)

      sweepChatBrowserContexts(Date.now() + RESIDENT_BROWSER_IDLE_MS - 1)
      expect(ctx.destroyed).toBe(false)

      sweepChatBrowserContexts(Date.now() + RESIDENT_BROWSER_IDLE_MS)
      expect(ctx.destroyed).toBe(true)
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

    it('never reaps a context whose tab the user is watching', () => {
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
      const ctx = acquireChatBrowserContext(DEFAULT_KEY, 'dh1', 'space-1') as unknown as FakeCtx
      endChatBrowserTurn(DEFAULT_KEY)
      apps.set('dh1', app('active', ['ai-browser']))

      sweepChatBrowserContexts(Date.now() + TURN_START_GRACE_MS)

      expect(ctx.destroyed).toBe(true)
    })

    it('does not close a revoked app’s pages while a turn is running or its tab is watched', () => {
      const ctx = acquireChatBrowserContext(DEFAULT_KEY, 'dh1', 'space-1') as unknown as FakeCtx
      endChatBrowserTurn(DEFAULT_KEY)
      apps.set('dh1', app('active', ['ai-browser']))
      generating.add(DEFAULT_KEY)
      sweepChatBrowserContexts(Date.now() + TURN_START_GRACE_MS)
      generating.clear()
      ctx.revealed = true
      sweepChatBrowserContexts(Date.now() + TURN_START_GRACE_MS)

      expect(ctx.destroyed).toBe(false)
    })

    it('notices an app that vanished without an uninstall event (space deleted)', () => {
      const ctx = acquireChatBrowserContext(DEFAULT_KEY, 'dh1', 'space-1') as unknown as FakeCtx
      endChatBrowserTurn(DEFAULT_KEY)
      apps.delete('dh1')

      sweepChatBrowserContexts()

      expect(ctx.destroyed).toBe(true)
    })

    it('notices an uninstalled app', () => {
      const ctx = acquireChatBrowserContext(DEFAULT_KEY, 'dh1', 'space-1') as unknown as FakeCtx
      endChatBrowserTurn(DEFAULT_KEY)
      apps.set('dh1', app('uninstalled'))

      sweepChatBrowserContexts()

      expect(ctx.destroyed).toBe(true)
    })

    it('reclaims a per-turn context whose turn never reported back', () => {
      const ctx = acquireChatBrowserContext(IM_KEY, 'dh1', 'space-1') as unknown as FakeCtx

      sweepChatBrowserContexts(Date.now() + 60_000)
      expect(ctx.destroyed).toBe(false)

      sweepChatBrowserContexts(Date.now() + 10 * 60_000)
      expect(ctx.destroyed).toBe(true)
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
        acquireChatBrowserContext(key, 'dh1', 'space-1')
        endChatBrowserTurn(key)
        vi.advanceTimersByTime(1000)
        keys.push(key)
      }
      // Past the window in which a context still counts as starting a turn.
      vi.advanceTimersByTime(TURN_START_GRACE_MS)
      return keys
    }

    it('makes room for a new chat by closing the least recently used idle one', () => {
      const keys = fillToCap()

      acquireChatBrowserContext('app-chat:dh1:local:direct:new', 'dh1', 'space-1')

      expect(hasChatBrowserContext(keys[0])).toBe(false)
      expect(keys.slice(1).every(hasChatBrowserContext)).toBe(true)
      expect(hasChatBrowserContext('app-chat:dh1:local:direct:new')).toBe(true)
    })

    it('skips a chat that is mid-turn or watched, even if it is the oldest', () => {
      const keys = fillToCap()
      generating.add(keys[0])
      ;(created[1] as FakeCtx).revealed = true

      acquireChatBrowserContext('app-chat:dh1:local:direct:new', 'dh1', 'space-1')

      expect(hasChatBrowserContext(keys[0])).toBe(true)
      expect(hasChatBrowserContext(keys[1])).toBe(true)
      expect(hasChatBrowserContext(keys[2])).toBe(false)
    })

    it('never evicts a chat that only just acquired its context and has not registered a turn yet', () => {
      const keys = fillToCap()
      // The oldest chat starts a turn: acquired, session still building, not yet "generating".
      acquireChatBrowserContext(keys[0], 'dh1', 'space-1')

      acquireChatBrowserContext('app-chat:dh1:local:direct:new', 'dh1', 'space-1')

      expect(hasChatBrowserContext(keys[0])).toBe(true)
      expect(hasChatBrowserContext(keys[1])).toBe(false)
    })

    it('goes over the cap rather than kill a live turn', () => {
      const keys = fillToCap()
      keys.forEach((k) => generating.add(k))

      acquireChatBrowserContext('app-chat:dh1:local:direct:new', 'dh1', 'space-1')

      expect(getChatBrowserStats().contexts).toBe(MAX_RESIDENT_BROWSER_CONTEXTS + 1)
      expect(console.warn).toHaveBeenCalled()
    })

    it('does not count a context that holds no pages', () => {
      const keys = fillToCap()
      created.forEach((c) => { c.ownedViewCount = 0 })

      acquireChatBrowserContext('app-chat:dh1:local:direct:new', 'dh1', 'space-1')

      expect(keys.every(hasChatBrowserContext)).toBe(true)
    })
  })
})
