/**
 * Clicking a conversation reference in a message opens the conversation its
 * short id names — a space conversation or a digital human's chat — and says
 * so plainly when it is gone.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildLocalSessionKey, getAppChatConversationId } from '../../../src/shared/apps/im-keys'
import { shortConversationId } from '../../../src/shared/conversation-reference'

const chatState = {
  currentSpaceId: 'space-a' as string | null,
  spaceStates: new Map<string, { conversations: { id: string; spaceId: string }[] }>(),
  loadConversations: vi.fn(async () => {}),
}
const appsState = { apps: [] as { id: string; spaceId: string | null; status?: string }[], loadApps: vi.fn(async () => {}) }
let records: { appId: string; source: string; chatId: string }[] = []
let freshRecords: typeof records = []
const show = vi.fn()
const navigateToConversation = vi.fn()
const navigateToAppChat = vi.fn()

vi.mock('../../../src/renderer/i18n', () => ({ default: { t: (key: string) => key } }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ useChatStore: { getState: () => chatState } }))
vi.mock('../../../src/renderer/stores/apps.store', () => ({ useAppsStore: { getState: () => appsState } }))
vi.mock('../../../src/renderer/stores/notification.store', () => ({ useNotificationStore: { getState: () => ({ show }) } }))
vi.mock('../../../src/renderer/stores/app-chat-sessions', () => ({
  getAppChatSessions: () => records,
  loadAppChatSessions: async () => { records = freshRecords; return records },
}))
vi.mock('../../../src/renderer/utils/conversation-navigation', () => ({ navigateToConversation, navigateToAppChat }))

const { openConversationReference } = await import('../../../src/renderer/components/chat/cross-conversation/open-conversation-reference')

const SPACE_CONV = '3a5d77ea-1111-4222-8333-444455556666'
const OTHER_SPACE_CONV = '9b8c7d6e-1111-4222-8333-444455556666'

beforeEach(() => {
  vi.clearAllMocks()
  chatState.currentSpaceId = 'space-a'
  chatState.spaceStates = new Map([
    ['space-b', { conversations: [{ id: OTHER_SPACE_CONV, spaceId: 'space-b' }] }],
    ['space-a', { conversations: [{ id: SPACE_CONV, spaceId: 'space-a' }] }],
  ])
  appsState.apps = [{ id: 'analyst', spaceId: 'space-a' }, { id: 'gone', spaceId: 'space-a', status: 'uninstalled' }]
  records = []
  freshRecords = []
})

describe('openConversationReference', () => {
  it('opens a space conversation, in whichever loaded space holds it', async () => {
    await openConversationReference(shortConversationId(SPACE_CONV))
    expect(navigateToConversation).toHaveBeenCalledWith('space-a', SPACE_CONV)
    await openConversationReference(shortConversationId(OTHER_SPACE_CONV))
    expect(navigateToConversation).toHaveBeenCalledWith('space-b', OTHER_SPACE_CONV)
    expect(show).not.toHaveBeenCalled()
  })

  it("opens a digital human's default and local chats in its own space", async () => {
    records = [{ appId: 'analyst', source: 'native', chatId: 'x' }, { appId: 'analyst', source: 'local', chatId: 'u1' }]
    await openConversationReference(shortConversationId(getAppChatConversationId('analyst')))
    expect(navigateToAppChat).toHaveBeenCalledWith('space-a', 'analyst', getAppChatConversationId('analyst'))
    const local = buildLocalSessionKey('analyst', 'u1')
    await openConversationReference(shortConversationId(local))
    expect(navigateToAppChat).toHaveBeenCalledWith('space-a', 'analyst', local)
  })

  it('looks again after refreshing the lists before giving up', async () => {
    const local = buildLocalSessionKey('analyst', 'new')
    freshRecords = [{ appId: 'analyst', source: 'local', chatId: 'new' }]
    await openConversationReference(shortConversationId(local))
    expect(chatState.loadConversations).toHaveBeenCalledWith('space-a')
    expect(navigateToAppChat).toHaveBeenCalledWith('space-a', 'analyst', local)
    expect(show).not.toHaveBeenCalled()
  })

  it('tells the user when the conversation is gone, including a removed digital human', async () => {
    freshRecords = [{ appId: 'gone', source: 'native', chatId: 'x' }]
    await openConversationReference(shortConversationId(getAppChatConversationId('gone')))
    await openConversationReference('00000000')
    expect(navigateToConversation).not.toHaveBeenCalled()
    expect(navigateToAppChat).not.toHaveBeenCalled()
    expect(show).toHaveBeenCalledTimes(2)
    expect(show.mock.calls[0][0]).toMatchObject({ title: 'This conversation is no longer available', variant: 'warning' })
  })
})
