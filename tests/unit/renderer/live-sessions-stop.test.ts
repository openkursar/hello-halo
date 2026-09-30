/**
 * Stopping an AI browser page from the tray: never a page another conversation
 * is on, never silently — a stop the main process refused reports failure — and
 * no stop control at all where this client cannot close a BrowserView.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  browser: { pages: {} as Record<string, any>, views: {} as Record<string, any>, operating: {} },
  electron: true,
  destroy: vi.fn(),
}))

// The hook is called as a plain function here; memoization has nothing to keep between calls.
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
}))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (s: string) => s }) }))
vi.mock('../../../src/renderer/api', () => ({ api: { stopAIBrowserPage: (...a: unknown[]) => env.destroy(...a) } }))
vi.mock('../../../src/renderer/api/transport', () => ({ isElectron: () => env.electron }))
vi.mock('../../../src/renderer/services/canvas-lifecycle', () => ({ canvasLifecycle: {} }))
vi.mock('../../../src/renderer/stores/terminal.store', () => ({
  useTerminalStore: (select: any) => select({ sessions: new Map(), aiWriting: new Set(), openInCanvas: vi.fn(), killSession: vi.fn() }),
}))
vi.mock('../../../src/renderer/stores/space.store', () => ({ useSpaceStore: (select: any) => select({ currentSpace: { id: 's1' } }) }))
vi.mock('../../../src/renderer/stores/app.store', () => ({ useAppStore: { getState: () => ({ navigate: vi.fn() }) } }))
vi.mock('../../../src/renderer/stores/apps.store', () => ({ useAppsStore: (select: any) => select({ apps: [] }) }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ useChatStore: (select: any) => select({ spaceStates: new Map() }) }))
vi.mock('../../../src/renderer/stores/ai-browser.store', async (original) => {
  const real = await original<typeof import('../../../src/renderer/stores/ai-browser.store')>()
  const useAIBrowserStore = Object.assign((select: any) => select(env.browser), { getState: () => env.browser })
  return { ...real, useAIBrowserStore }
})

const { useLiveSessions } = await import('../../../src/renderer/hooks/useLiveSessions')

const ownPage = { viewId: 'p', conversationId: 'conv-a', spaceId: 's1', url: null, title: 'Page', lastActivityAt: 1 }

describe('stopping a browser page from the tray', () => {
  beforeEach(() => {
    env.browser = { pages: { p: ownPage }, views: { 'conv-a': { viewId: 'p' } }, operating: {} }
    env.electron = true
    env.destroy.mockReset()
    env.destroy.mockResolvedValue({ stopped: true })
  })

  it('closes a page its conversation opened', async () => {
    const { sessions, stop } = useLiveSessions()
    expect(await stop(sessions[0])).toEqual({ stopped: true })
    expect(env.destroy).toHaveBeenCalledWith('p', 'conv-a')
  })

  it('refuses once another conversation has moved onto the page', async () => {
    const { sessions, stop } = useLiveSessions()
    env.browser.views['conv-b'] = { viewId: 'p' }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await stop(sessions[0])).toEqual({ stopped: false, reason: 'in-use' })
    expect(env.destroy).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('reports a stop the main process refused instead of pretending', async () => {
    env.destroy.mockResolvedValue({ stopped: false, reason: 'in-use' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { sessions, stop } = useLiveSessions()

    expect(await stop(sessions[0])).toEqual({ stopped: false, reason: 'in-use' })
    warn.mockRestore()
  })

  it('offers no stop control where BrowserViews do not exist (remote clients)', () => {
    env.electron = false
    expect(useLiveSessions().sessions[0].stoppable).toBe(false)
    env.electron = true
    expect(useLiveSessions().sessions[0].stoppable).toBe(true)
  })
})
