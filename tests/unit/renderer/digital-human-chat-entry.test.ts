/**
 * A digital human's "Chat" continues the owner's latest Halo chat with it and
 * starts one only when there is none; "new conversation" always starts one
 * (#583). The latest chat is read from the records the conversation lists
 * already hold — never an IM, API or other digital human's chat.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildLocalSessionKey, getAppChatConversationId } from '../../../src/shared/apps/im-keys'

const env = vi.hoisted(() => ({
  api: {
    imSessionsList: vi.fn(),
    onImSessionUpdated: vi.fn(() => () => {}),
    appSessionCreate: vi.fn(),
  },
  selectAppChatConversation: vi.fn(),
  navigate: vi.fn(),
}))

vi.mock('../../../src/renderer/api', () => ({ api: env.api }))
vi.mock('../../../src/renderer/stores/app.store', () => ({ useAppStore: { getState: () => ({ navigate: env.navigate }) } }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({
  useChatStore: { getState: () => ({ currentSpaceId: 'space-1', selectAppChatConversation: env.selectAppChatConversation }), setState: vi.fn() },
}))
vi.mock('../../../src/renderer/stores/space.store', () => ({ useSpaceStore: { getState: () => ({ spaces: [], haloSpace: null }) } }))
vi.mock('../../../src/renderer/utils/skill-command', () => ({ deriveSkillCommand: (name: string) => `/${name}` }))
vi.mock('../../../src/renderer/utils/store-target-space', () => ({ resolveStoreTargetSpace: () => null }))

const record = (source: string, chatId: string, lastActiveAt: number, extra: Record<string, unknown> = {}) => ({
  appId: 'analyst', channel: source === 'im' ? 'fixture-im' : source, source, instanceId: '', chatId, chatType: 'direct',
  displayName: '', proactive: false, lastActiveAt, messageCount: 1, lastMessage: 'hello', ...extra,
})

async function load() {
  vi.resetModules()
  const sessions = await import('../../../src/renderer/stores/app-chat-sessions')
  const navigation = await import('../../../src/renderer/utils/conversation-navigation')
  return { sessions, navigation }
}

function opened(): string | undefined {
  return env.selectAppChatConversation.mock.calls.at(-1)?.[2]
}

beforeEach(() => {
  vi.clearAllMocks()
  env.api.appSessionCreate.mockResolvedValue({ success: true, data: { conversationId: buildLocalSessionKey('analyst', 'created'), record: {} } })
})

describe('Chat with a digital human', () => {
  it('continues its most recent Halo chat without creating one', async () => {
    env.api.imSessionsList.mockResolvedValue({ success: true, data: [
      record('im', 'wx-1', 900),
      { ...record('local', 'someone-else', 950), appId: 'other' },
      record('local', 'recent', 500),
      record('native', 'default', 300),
      record('local', 'older', 100),
    ] })
    const { sessions, navigation } = await load()
    await sessions.loadAppChatSessions()
    env.api.imSessionsList.mockClear()

    await expect(navigation.openDigitalHumanChat('analyst', 'space-1')).resolves.toBe(true)

    expect(opened()).toBe(buildLocalSessionKey('analyst', 'recent'))
    expect(env.api.appSessionCreate).not.toHaveBeenCalled()
    expect(env.api.imSessionsList).not.toHaveBeenCalled()
  })

  it('continues the default chat when it is the latest, but not once it is empty', async () => {
    env.api.imSessionsList.mockResolvedValue({ success: true, data: [record('native', 'default', 500), record('local', 'older', 100)] })
    let { sessions, navigation } = await load()
    await sessions.loadAppChatSessions()
    await navigation.openDigitalHumanChat('analyst', 'space-1')
    expect(opened()).toBe(getAppChatConversationId('analyst'))

    env.api.imSessionsList.mockResolvedValue({ success: true, data: [record('native', 'default', 500, { messageCount: 0, lastMessage: undefined })] })
    ;({ sessions, navigation } = await load())
    await sessions.loadAppChatSessions()
    await navigation.openDigitalHumanChat('analyst', 'space-1')
    expect(opened()).toBe(buildLocalSessionKey('analyst', 'created'))
  })

  it('starts one when it has no Halo chat', async () => {
    env.api.imSessionsList.mockResolvedValue({ success: true, data: [record('im', 'wx-1', 900), record('http', 'order-1', 800)] })
    const { sessions, navigation } = await load()
    await sessions.loadAppChatSessions()

    await navigation.openDigitalHumanChat('analyst', 'space-1')

    expect(env.api.appSessionCreate).toHaveBeenCalledTimes(1)
    expect(opened()).toBe(buildLocalSessionKey('analyst', 'created'))
  })

  it('reads the records once when no list has read them yet, rather than taking that for none', async () => {
    env.api.imSessionsList.mockResolvedValue({ success: true, data: [record('local', 'recent', 500)] })
    const { navigation } = await load()

    await navigation.openDigitalHumanChat('analyst', 'space-1')

    expect(env.api.imSessionsList).toHaveBeenCalledTimes(1)
    expect(env.api.appSessionCreate).not.toHaveBeenCalled()
    expect(opened()).toBe(buildLocalSessionKey('analyst', 'recent'))
  })
  it('starts one on purpose, and says so, when the conversations cannot be read; continues once they can', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    env.api.imSessionsList.mockResolvedValue({ success: false, error: 'registry unavailable' })
    const { sessions, navigation } = await load()
    await sessions.loadAppChatSessions()
    expect(sessions.isAppChatSessionsLoading()).toBe(false)

    await expect(navigation.openDigitalHumanChat('analyst', 'space-1')).resolves.toBe(true)
    expect(env.api.imSessionsList).toHaveBeenCalledTimes(2)
    expect(env.api.appSessionCreate).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not read existing conversations'), { appId: 'analyst' })

    env.api.imSessionsList.mockResolvedValue({ success: true, data: [record('local', 'recent', 500)] })
    await navigation.openDigitalHumanChat('analyst', 'space-1')
    expect(env.api.appSessionCreate).toHaveBeenCalledTimes(1)
    expect(opened()).toBe(buildLocalSessionKey('analyst', 'recent'))
    warn.mockRestore()
  })
})

describe('Turning to a digital human from the input (recipient picker, "@" mention)', () => {
  it('continues its most recent Halo chat instead of starting one', async () => {
    env.api.imSessionsList.mockResolvedValue({ success: true, data: [record('im', 'wx-1', 900), record('local', 'recent', 500), record('local', 'older', 100)] })
    const { sessions, navigation } = await load()
    await sessions.loadAppChatSessions()

    await expect(navigation.continueDigitalHumanConversation('analyst')).resolves.toBe(buildLocalSessionKey('analyst', 'recent'))
    expect(env.api.appSessionCreate).not.toHaveBeenCalled()
  })

  it('starts one only when it has no Halo chat', async () => {
    env.api.imSessionsList.mockResolvedValue({ success: true, data: [record('im', 'wx-1', 900)] })
    const { sessions, navigation } = await load()
    await sessions.loadAppChatSessions()

    await expect(navigation.continueDigitalHumanConversation('analyst')).resolves.toBe(buildLocalSessionKey('analyst', 'created'))
    expect(env.api.appSessionCreate).toHaveBeenCalledTimes(1)
  })
})

describe('A new conversation with a digital human', () => {
  it('always starts one, even with chats to continue', async () => {
    env.api.imSessionsList.mockResolvedValue({ success: true, data: [record('local', 'recent', 500)] })
    const { sessions, navigation } = await load()
    await sessions.loadAppChatSessions()

    await navigation.openDigitalHumanChat('analyst', 'space-1', { newConversation: true })

    expect(env.api.appSessionCreate).toHaveBeenCalledTimes(1)
    expect(opened()).toBe(buildLocalSessionKey('analyst', 'created'))
  })

  it('reports a refused start', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    env.api.appSessionCreate.mockResolvedValue({ success: false, error: 'no workspace' })
    env.api.imSessionsList.mockResolvedValue({ success: true, data: [] })
    const { navigation } = await load()

    await expect(navigation.openDigitalHumanChat('analyst', 'space-1')).resolves.toBe(false)
    expect(env.selectAppChatConversation).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
