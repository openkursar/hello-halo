/**
 * A digital human's in-app toasts replace each other: one that runs every few
 * minutes shows its newest result in one toast instead of piling them up.
 * Toasts from different digital humans, and from anything else, stay apart.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const observed = vi.hoisted(() => ({ send: vi.fn((_channel: string, _payload: unknown) => true) }))

vi.mock('electron', () => ({ Notification: class { static isSupported() { return true } } }))
vi.mock('../../../src/main/foundation/config.service', () => ({
  getConfig: () => ({ notifications: { taskComplete: true } }),
}))
vi.mock('../../../src/main/foundation/window.service', () => ({
  // Focused: macOS hides system notifications for the foreground app, so these become in-app toasts.
  getMainWindow: () => ({ isDestroyed: () => false, isFocused: () => true }),
  sendToRenderer: observed.send,
}))
vi.mock('../../../src/main/http/websocket', () => ({
  broadcastToAll: vi.fn(),
  getAuthenticatedClientCount: () => 0,
}))

import { notifyAppEvent } from '../../../src/main/services/notification.service'

const toastIds = () => observed.send.mock.calls
  .filter(([channel]) => channel === 'notification:toast')
  .map(([, payload]) => (payload as { id?: string }).id)

beforeEach(() => {
  observed.send.mockClear()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('in-app toasts of a digital human', () => {
  it('gives every toast of one digital human the same id, so the newest replaces the last', () => {
    notifyAppEvent('Price watcher', 'Run 1 done', { appId: 'app-1' })
    notifyAppEvent('Price watcher', 'Run 2 done', { appId: 'app-1' })
    notifyAppEvent('Researcher', 'Ready', { appId: 'app-2' })

    const [first, second, other] = toastIds()
    expect(first).toBeDefined()
    expect(second).toBe(first)
    expect(other).not.toBe(first)
  })

  it('leaves toasts that belong to no digital human as they were', () => {
    notifyAppEvent('Halo', 'Something happened')

    expect(toastIds()).toEqual([undefined])
  })
})

describe('the toast list', () => {
  it('keeps one toast per id, the newest, at the end of the stack', async () => {
    const { useNotificationStore } = await import('../../../src/renderer/stores/notification.store')
    const { show } = useNotificationStore.getState()
    useNotificationStore.getState().clear()

    show({ id: 'app-notification:app-1', title: 'Price watcher', body: 'Run 1 done', variant: 'default', duration: 0 })
    show({ title: 'Halo', body: 'Update ready', variant: 'default', duration: 0 })
    show({ id: 'app-notification:app-1', title: 'Price watcher', body: 'Run 2 done', variant: 'default', duration: 0 })

    expect(useNotificationStore.getState().toasts.map(toast => toast.body)).toEqual(['Update ready', 'Run 2 done'])
  })
})
