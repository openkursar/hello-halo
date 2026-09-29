/**
 * The terminal entry's availability is a platform signal: it must not depend on
 * which conversation is on screen, nor on that conversation's catalog having
 * been loaded by a composer that a digital human's chat does not show.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const apiMock = vi.hoisted(() => ({ listToolsets: vi.fn() }))
vi.mock('../../../src/renderer/api', () => ({ api: apiMock }))
vi.mock('../../../src/renderer/services/canvas-lifecycle', () => ({ canvasLifecycle: {} }))
vi.mock('../../../src/renderer/stores/team.store', () => ({ isRemoteMemberAppId: () => false }))
vi.mock('../../../src/renderer/stores/space.store', () => ({ useSpaceStore: () => null }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ useChatStore: () => null }))
vi.mock('../../../src/renderer/stores/terminal.store', () => ({ useTerminalStore: () => null }))

import { terminalProbeConversationId } from '../../../src/renderer/hooks/useUserTerminal'
import { useToolsetsStore } from '../../../src/renderer/stores/toolsets.store'

describe('terminalProbeConversationId', () => {
  it('is the space\'s regular conversation, even while a digital human is selected', () => {
    const spaceStates = new Map([['s1', {
      conversations: [],
      currentConversationId: 'regular-1',
      selectedAppChat: { appId: 'a1', conversationId: 'app-chat:a1' },
    }]])
    expect(terminalProbeConversationId({ currentSpaceId: 's1', spaceStates })).toBe('regular-1')
  })

  it('is null without a space or a regular conversation', () => {
    expect(terminalProbeConversationId({ currentSpaceId: null, spaceStates: new Map() })).toBeNull()
    expect(terminalProbeConversationId({ currentSpaceId: 's1', spaceStates: new Map([['s1', { conversations: [], currentConversationId: null }]]) })).toBeNull()
  })
})

describe('toolsets store ensureLoaded', () => {
  beforeEach(() => {
    apiMock.listToolsets.mockReset()
    useToolsetsStore.setState({ byConversation: new Map() })
  })

  it('reads a catalog once for concurrent callers, and not again once loaded', async () => {
    apiMock.listToolsets.mockResolvedValue({ success: true, data: [{ id: 'ai-terminal', displayName: 'Terminal', summary: '', open: false }] })
    const { ensureLoaded } = useToolsetsStore.getState()

    await Promise.all([ensureLoaded('s1', 'regular-1'), ensureLoaded('s1', 'regular-1'), ensureLoaded('s1', 'regular-1')])
    await ensureLoaded('s1', 'regular-1')

    expect(apiMock.listToolsets).toHaveBeenCalledTimes(1)
    expect(useToolsetsStore.getState().byConversation.get('regular-1')?.some(t => t.id === 'ai-terminal')).toBe(true)
  })

  it('tries again after a failed read', async () => {
    apiMock.listToolsets.mockResolvedValueOnce({ success: false, error: 'x' })
    await useToolsetsStore.getState().ensureLoaded('s1', 'regular-1')
    apiMock.listToolsets.mockResolvedValueOnce({ success: true, data: [] })
    await useToolsetsStore.getState().ensureLoaded('s1', 'regular-1')
    expect(apiMock.listToolsets).toHaveBeenCalledTimes(2)
  })
})
