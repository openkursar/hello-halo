/**
 * One registry feed for every list of digital-human conversations: a single
 * poll and subscription however many lists are mounted, and no notification
 * when a poll finds nothing new.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const apiMock = vi.hoisted(() => ({
  imSessionsList: vi.fn(),
  onImSessionUpdated: vi.fn(),
}))
vi.mock('../../../src/renderer/api', () => ({ api: apiMock }))

import { acquireAppChatSessions, getAppChatSessions, subscribeAppChatSessions } from '../../../src/renderer/stores/app-chat-sessions'

const record = (chatId: string, lastMessage: string) => ({ appId: 'a1', channel: 'local', source: 'local', chatId, lastMessage })

describe('app chat session feed', () => {
  let pushUpdate: () => void = () => {}
  const unsubscribe = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    apiMock.imSessionsList.mockReset()
    apiMock.onImSessionUpdated.mockReset().mockImplementation((cb: () => void) => { pushUpdate = cb; return unsubscribe })
    unsubscribe.mockReset()
  })
  afterEach(() => { vi.useRealTimers() })

  it('polls and subscribes once for any number of consumers, and stops with the last', async () => {
    apiMock.imSessionsList.mockResolvedValue({ success: true, data: [record('x', 'hi')] })
    const releases = [acquireAppChatSessions(), acquireAppChatSessions(), acquireAppChatSessions()]
    await vi.waitFor(() => expect(getAppChatSessions()).toHaveLength(1))

    expect(apiMock.imSessionsList).toHaveBeenCalledTimes(1)
    expect(apiMock.onImSessionUpdated).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(15_000)
    expect(apiMock.imSessionsList).toHaveBeenCalledTimes(2)

    releases.forEach(release => release())
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(apiMock.imSessionsList).toHaveBeenCalledTimes(2)
  })

  it('tells listeners only when the records changed', async () => {
    apiMock.imSessionsList.mockResolvedValue({ success: true, data: [record('y', 'same')] })
    const listener = vi.fn()
    const stop = subscribeAppChatSessions(listener)
    const release = acquireAppChatSessions()
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1))

    pushUpdate()
    await vi.advanceTimersByTimeAsync(15_000)
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(1)

    apiMock.imSessionsList.mockResolvedValue({ success: true, data: [record('y', 'changed')] })
    pushUpdate()
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2))
    expect(getAppChatSessions()[0].lastMessage).toBe('changed')

    stop()
    release()
  })
})
