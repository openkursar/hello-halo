/**
 * A pending AI request to turn on a toolset opens the "+" panel as soon as the
 * composer sees it — the hook does not wait for anything — and is consumed so
 * a later remount does not open the panel again.
 */

import { describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ state: null as any }))
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useEffect: (effect: () => unknown) => { effect() },
  useMemo: (compute: () => unknown) => compute(),
}))
vi.mock('../../../src/renderer/stores/space.store', () => ({ useSpaceStore: (select: any) => select({ currentSpace: { id: 'space-1' } }) }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ useChatStore: () => 'conv-1', selectActiveConversationId: () => 'conv-1' }))
vi.mock('../../../src/renderer/stores/toolsets.store', () => ({ useToolsetsStore: (select: any) => select(env.state) }))

import { useComposerToolsets } from '../../../src/renderer/components/chat/composer-menu/useComposerToolsets'

function storeWith(requestSignal: Map<string, number>) {
  return {
    byConversation: new Map([['conv-1', [{ id: 'ai-terminal', displayName: 'Terminal', summary: '', open: false }]]]),
    aiRequested: new Map([['conv-1', new Set(['ai-terminal'])]]),
    requestSignal,
    refresh: vi.fn(async () => {}),
    open: vi.fn(),
    close: vi.fn(),
    consumeRequestHighlight: vi.fn(),
    consumeRequestSignal: vi.fn(),
  }
}

describe('toolset requests in the composer', () => {
  it('lists the automatic capabilities this conversation can use, which no switch can turn off', () => {
    env.state = storeWith(new Map())
    const terminal = { id: 'ai-terminal', displayName: 'Terminal', summary: '', open: true, configurable: false }
    const excluded = { id: 'halo-team', displayName: 'Team Collaboration', summary: '', open: false, configurable: false }
    const optional = { id: 'extra', displayName: 'Extra', summary: '', open: false }
    env.state.byConversation.set('conv-1', [terminal, excluded, optional])
    const controls = useComposerToolsets({ enabled: true, panelOpen: false, onRequested: vi.fn() })
    expect(controls.list).toEqual([terminal, optional])
    controls.toggle(terminal)
    expect(env.state.close).not.toHaveBeenCalled()
    expect(env.state.open).not.toHaveBeenCalled()
    controls.toggle(optional)
    expect(env.state.open).toHaveBeenCalledWith('space-1', 'conv-1', 'extra')
  })


  it('open the panel at once and are consumed', () => {
    env.state = storeWith(new Map([['conv-1', 1]]))
    const onRequested = vi.fn()
    vi.stubGlobal('window', { setTimeout: vi.fn(), clearTimeout: vi.fn() })
    const toolsets = useComposerToolsets({ enabled: true, panelOpen: false, onRequested })
    expect(onRequested).toHaveBeenCalledOnce()
    expect(env.state.consumeRequestSignal).toHaveBeenCalledWith('conv-1')
    expect(toolsets.requested.has('ai-terminal')).toBe(true)
    vi.unstubAllGlobals()
  })

  it('do nothing on surfaces whose tools the broker does not govern, or without a request', () => {
    env.state = storeWith(new Map([['conv-1', 1]]))
    const onRequested = vi.fn()
    useComposerToolsets({ enabled: false, panelOpen: false, onRequested })
    env.state = storeWith(new Map())
    useComposerToolsets({ enabled: true, panelOpen: false, onRequested })
    expect(onRequested).not.toHaveBeenCalled()
  })
})
