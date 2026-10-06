/**
 * Clearing all of a digital human's conversations at once: its Halo chats and
 * IM chats that have history are each cleared as /clear clears them; API
 * sessions, team chats and empty chats are left alone, and one failure does
 * not stop the rest.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  clearAppChat: vi.fn(async (_appId: string, _spaceId: string, _conversationId?: string) => {}),
  clearImSession: vi.fn(async (..._args: unknown[]) => {}),
  clearSupplementBuffer: vi.fn(),
  clearImPermissionContext: vi.fn(),
  clearRelays: vi.fn(),
  app: { id: 'person', spaceId: 'space-1' } as { id: string; spaceId: string } | null,
}))

vi.mock('../../../../src/main/apps/manager', () => ({ getAppManager: () => ({ getApp: () => m.app }) }))
vi.mock('../../../../src/main/apps/runtime/app-chat', () => ({ clearAppChat: m.clearAppChat, clearImSession: m.clearImSession }))
vi.mock('../../../../src/main/apps/runtime/dispatch-inbound', () => ({ clearSupplementBuffer: m.clearSupplementBuffer }))
vi.mock('../../../../src/main/apps/runtime/im-permission-registry', () => ({ clearImPermissionContext: m.clearImPermissionContext }))
vi.mock('../../../../src/main/apps/runtime/pending-relays', () => ({ getPendingRelayStore: () => ({ clear: m.clearRelays }) }))
vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({
  getImSessionRegistry: () => ({ getAllSessions: () => m.sessions }),
}))

import { clearAllChats, countClearableChats } from '../../../../src/main/apps/runtime/chat-reset'

const session = (channel: string, chatId: string, extra: Record<string, unknown> = {}) => ({
  appId: 'person', channel, chatId, chatType: 'direct', messageCount: 3, ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  m.app = { id: 'person', spaceId: 'space-1' }
  m.sessions = [
    session('native', 'default', { source: 'native' }),
    session('local', 'uuid-1', { source: 'local' }),
    session('local', 'uuid-empty', { source: 'local', messageCount: 0 }),
    session('wecom-bot', 'group-1', { source: 'im', chatType: 'group' }),
    session('wecom-bot', 'li', { source: 'im' }),
    session('feishu-bot', 'legacy-chat', { messageCount: undefined }),
    session('http', 'api-client', { source: 'http' }),
    session('wecom-bot', 'team-chat', { source: 'im', chatType: 'group', teamContext: { teamId: 't', epochId: 'e' } }),
  ]
})

describe('countClearableChats', () => {
  it('counts Halo and IM chats with history, not API sessions, team chats or empty chats', () => {
    expect(countClearableChats('person')).toEqual({ total: 5, im: 3 })
  })
})

describe('clearAllChats', () => {
  it('clears each chat as /clear does, and nothing else', async () => {
    expect(await clearAllChats('person')).toEqual({ cleared: 5, failed: 0 })

    expect(m.clearAppChat.mock.calls).toEqual([
      ['person', 'space-1', undefined],
      ['person', 'space-1', 'app-chat:person:local:direct:uuid-1'],
    ])
    expect(m.clearImSession.mock.calls).toEqual([
      ['person', 'space-1', 'wecom-bot', 'group', 'group-1'],
      ['person', 'space-1', 'wecom-bot', 'direct', 'li'],
      ['person', 'space-1', 'feishu-bot', 'direct', 'legacy-chat'],
    ])
    for (const key of ['app-chat:person:wecom-bot:group:group-1', 'app-chat:person:wecom-bot:direct:li', 'app-chat:person:feishu-bot:direct:legacy-chat']) {
      expect(m.clearSupplementBuffer).toHaveBeenCalledWith(key)
      expect(m.clearImPermissionContext).toHaveBeenCalledWith(key)
      expect(m.clearRelays).toHaveBeenCalledWith(key)
    }
  })

  it('goes on past a chat that cannot be cleared and counts it', async () => {
    m.clearImSession.mockRejectedValueOnce(new Error('transcript locked'))

    expect(await clearAllChats('person')).toEqual({ cleared: 4, failed: 1 })
    expect(m.clearImSession).toHaveBeenCalledTimes(3)
  })

  it('refuses a digital human that is not installed', async () => {
    m.app = null

    await expect(clearAllChats('person')).rejects.toThrow('Digital human not found')
    expect(m.clearAppChat).not.toHaveBeenCalled()
  })
})
