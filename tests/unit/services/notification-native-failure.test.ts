import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventEmitter } from 'node:events'

const observed = vi.hoisted(() => ({
  notifications: [] as EventEmitter[],
  send: vi.fn(() => true),
  broadcast: vi.fn(),
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    Notification: class extends EventEmitter {
      static isSupported() { return true }
      constructor() {
        super()
        observed.notifications.push(this)
      }
      show() {}
    },
  }
})
vi.mock('../../../src/main/foundation/config.service', () => ({
  getConfig: () => ({ notifications: { taskComplete: true } }),
}))
vi.mock('../../../src/main/foundation/window.service', () => ({
  getMainWindow: () => ({ isDestroyed: () => false, isFocused: () => false }),
  sendToRenderer: observed.send,
}))
vi.mock('../../../src/main/http/websocket', () => ({
  broadcastToAll: observed.broadcast,
  getAuthenticatedClientCount: () => 0,
}))

import { notifyAppEvent, notifyTaskComplete } from '../../../src/main/services/notification.service'

beforeEach(() => {
  observed.notifications.length = 0
  observed.send.mockClear()
  observed.broadcast.mockClear()
})

describe('asynchronous native notification failure', () => {
  it('delivers a task completion toast once when the system rejects the notification', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      notifyTaskComplete('Report')
      expect(observed.send).not.toHaveBeenCalled()
      observed.notifications[0].emit('failed', {}, 'Missing app signature')
      observed.notifications[0].emit('failed', {}, 'Repeated rejection')
      expect(observed.send).toHaveBeenCalledTimes(1)
      expect(observed.send).toHaveBeenCalledWith('notification:toast', expect.objectContaining({
        title: 'Halo', body: 'Task complete: Report',
      }))
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps app navigation metadata in the fallback delivered to desktop and remote clients', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      notifyAppEvent('Researcher', 'Ready for review', { appId: 'app-1', entryId: 'entry-1', teamId: 'team-1' })
      observed.notifications[0].emit('failed', {}, 'Permission denied')
      const payload = expect.objectContaining({
        title: 'Researcher', body: 'Ready for review', appId: 'app-1', entryId: 'entry-1', teamId: 'team-1',
      })
      expect(observed.send).toHaveBeenCalledWith('notification:toast', payload)
      expect(observed.broadcast).toHaveBeenCalledWith('notification:toast', payload)
    } finally {
      warn.mockRestore()
    }
  })
})
