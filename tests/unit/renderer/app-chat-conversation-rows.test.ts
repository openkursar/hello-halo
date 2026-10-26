/**
 * The workspace's conversation board lists the chats a person holds with a
 * digital human — its default chat once used, and its local chats — and none of
 * the sessions other people or machinery hold with it. Remote calls (HTTP API
 * sessions) in particular stay on the digital human's own page (#454): a
 * backend can open hundreds of them, which would flood the board. The same rows
 * feed the composer's @ conversation candidates.
 */

import { describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ records: [] as unknown[] }))

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  useMemo: (compute: () => unknown) => compute(),
  useEffect: () => {},
}))
vi.mock('../../../src/renderer/stores/app-chat-sessions', () => ({
  acquireAppChatSessions: () => () => {},
  subscribeAppChatSessions: () => () => {},
  getAppChatSessions: () => env.records,
}))
vi.mock('../../../src/renderer/hooks/useSpaceDigitalHumans', () => ({
  useSpaceDigitalHumans: () => [{ id: 'concierge', spaceId: 'space-1', status: 'active', installedAt: 1, spec: { type: 'automation', name: 'Concierge' } }],
}))
vi.mock('../../../src/renderer/stores/app-chat-pins.store', () => ({
  useAppChatPinsStore: (select: (state: unknown) => unknown) => select({ pinned: {} }),
}))
vi.mock('../../../src/renderer/i18n', () => ({ getCurrentLanguage: () => 'en' }))
vi.mock('../../../src/renderer/utils/spec-i18n', () => ({ resolveSpecI18n: (spec: unknown) => spec }))

import { useAppChatConversationRows } from '../../../src/renderer/hooks/useAppChatConversationRows'

const record = (channel: string, source: string, chatId: string) => ({
  appId: 'concierge', channel, source, instanceId: '', chatId, chatType: 'direct',
  displayName: chatId, proactive: false, lastActiveAt: 1_000, messageCount: 2, lastMessage: 'hello',
})

describe('digital-human rows on the conversation board', () => {
  it('lists the default and local chats, and no remote call or IM chat', () => {
    env.records = [
      record('native', 'native', 'default'),
      record('local', 'local', 'sess-1'),
      record('http', 'http', 'order-42'),
      record('http', 'http', 'order-43'),
      record('wecom-bot', 'im', 'wx-1'),
    ]

    expect(useAppChatConversationRows('space-1').map(row => row.id)).toEqual([
      'app-chat:concierge',
      'app-chat:concierge:local:direct:sess-1',
    ])
  })
})
