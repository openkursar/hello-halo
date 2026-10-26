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

// A list deciding whether it has anything to show must tell "none" from "not
// read yet"; the first read answers, even when it finds nothing or fails.
describe('before the first read', () => {
  async function freshFeed() {
    vi.resetModules()
    return import('../../../src/renderer/stores/app-chat-sessions')
  }

  it('is loading until a read finishes, and tells listeners when one finds nothing', async () => {
    const feed = await freshFeed()
    apiMock.imSessionsList.mockResolvedValue({ success: true, data: [] })
    const listener = vi.fn()
    const stop = feed.subscribeAppChatSessions(listener)
    expect(feed.isAppChatSessionsLoading()).toBe(true)

    const release = feed.acquireAppChatSessions()
    await vi.waitFor(() => expect(feed.isAppChatSessionsLoading()).toBe(false))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(feed.getAppChatSessions()).toEqual([])

    stop()
    release()
  })

  it('stops loading after a failed read too, so no list waits for ever', async () => {
    const feed = await freshFeed()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    apiMock.imSessionsList.mockResolvedValue({ success: false, error: 'registry unavailable' })

    const release = feed.acquireAppChatSessions()
    await vi.waitFor(() => expect(feed.isAppChatSessionsLoading()).toBe(false))

    release()
    warn.mockRestore()
  })
})
