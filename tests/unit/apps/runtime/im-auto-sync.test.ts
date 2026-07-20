/**
 * Unit tests for apps/runtime/im-auto-sync.ts
 *
 * Covers the system-driven IM push at run completion:
 *   - empty / whitespace-only finalText → no-op
 *   - no proactive sessions → no-op
 *   - registry / manager unavailable → safe no-op or skip count
 *   - per-session outcomes (sent / disconnected / instance missing / error)
 *   - truncation at MAX_PUSH_LENGTH
 *   - never throws even when transport throws
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ImSessionRecord } from '../../../../src/shared/types/im-channel'

// Mock the registry + channel manager accessors before importing the module
// under test. Each test re-wires the mocks to control the scenario.

const mockGetProactiveSessions = vi.fn()
const mockGetInstance = vi.fn()

vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({
  getImSessionRegistry: () => ({
    getProactiveSessions: mockGetProactiveSessions,
  }),
}))

vi.mock('../../../../src/main/apps/runtime/im-channels', () => ({
  getActiveImChannelManager: () => ({
    getInstance: mockGetInstance,
  }),
}))

import { autoSyncRunResult } from '../../../../src/main/apps/runtime/im-auto-sync'

// ============================================
// Helpers
// ============================================

function makeSession(overrides: Partial<ImSessionRecord> = {}): ImSessionRecord {
  return {
    appId: 'app-1',
    channel: 'wecom-bot',
    source: 'im',
    instanceId: 'inst-1',
    chatId: 'chat-1',
    chatType: 'group',
    displayName: 'Test Group',
    proactive: true,
    lastActiveAt: Date.now(),
    ...overrides,
  }
}

function makeInstance(overrides: { connected?: boolean; pushReturns?: boolean | (() => boolean) } = {}) {
  const { connected = true, pushReturns = true } = overrides
  return {
    isConnected: vi.fn().mockReturnValue(connected),
    pushToChat: vi.fn().mockImplementation(() => {
      return typeof pushReturns === 'function' ? pushReturns() : pushReturns
    }),
  }
}

const baseInput = {
  appId: 'app-1',
  appName: 'Test App',
  runId: 'run-1234567890',
  runTag: 'run-1234',
}

beforeEach(() => {
  mockGetProactiveSessions.mockReset()
  mockGetInstance.mockReset()
})

// ============================================
// Tests
// ============================================

describe('autoSyncRunResult', () => {
  describe('preconditions / no-op paths', () => {
    it('returns zero report when finalText is empty', async () => {
      const report = await autoSyncRunResult({ ...baseInput, finalText: '' })
      expect(report).toEqual({ subscribed: 0, sent: 0, skipped: 0, failed: 0 })
      expect(mockGetProactiveSessions).not.toHaveBeenCalled()
    })

    it('returns zero report when finalText is whitespace only', async () => {
      const report = await autoSyncRunResult({ ...baseInput, finalText: '   \n\t  \n' })
      expect(report).toEqual({ subscribed: 0, sent: 0, skipped: 0, failed: 0 })
      expect(mockGetProactiveSessions).not.toHaveBeenCalled()
    })

    it('returns zero report when no proactive sessions are subscribed', async () => {
      mockGetProactiveSessions.mockReturnValue([])
      const report = await autoSyncRunResult({ ...baseInput, finalText: 'hello' })
      expect(report.subscribed).toBe(0)
      expect(report.sent).toBe(0)
      expect(mockGetInstance).not.toHaveBeenCalled()
    })
  })

  describe('successful dispatch', () => {
    it('pushes finalText verbatim when under the length cap', async () => {
      const session = makeSession()
      const instance = makeInstance()
      mockGetProactiveSessions.mockReturnValue([session])
      mockGetInstance.mockReturnValue(instance)

      const report = await autoSyncRunResult({ ...baseInput, finalText: 'short message' })

      expect(report).toEqual({ subscribed: 1, sent: 1, skipped: 0, failed: 0 })
      expect(instance.pushToChat).toHaveBeenCalledOnce()
      expect(instance.pushToChat).toHaveBeenCalledWith('chat-1', 'short message', 'group')
    })

    it('dispatches to every subscribed session sequentially', async () => {
      const s1 = makeSession({ chatId: 'chat-a', instanceId: 'inst-a' })
      const s2 = makeSession({ chatId: 'chat-b', instanceId: 'inst-b' })
      const s3 = makeSession({ chatId: 'chat-c', instanceId: 'inst-a' })
      mockGetProactiveSessions.mockReturnValue([s1, s2, s3])

      const instA = makeInstance()
      const instB = makeInstance()
      mockGetInstance.mockImplementation((id: string) =>
        id === 'inst-a' ? instA : id === 'inst-b' ? instB : undefined,
      )

      const report = await autoSyncRunResult({ ...baseInput, finalText: 'multi-send' })

      expect(report).toEqual({ subscribed: 3, sent: 3, skipped: 0, failed: 0 })
      expect(instA.pushToChat).toHaveBeenCalledTimes(2)
      expect(instB.pushToChat).toHaveBeenCalledTimes(1)
    })

    it('truncates body exceeding the length cap and appends marker', async () => {
      const session = makeSession()
      const instance = makeInstance()
      mockGetProactiveSessions.mockReturnValue([session])
      mockGetInstance.mockReturnValue(instance)

      const longText = 'a'.repeat(5000)
      const report = await autoSyncRunResult({ ...baseInput, finalText: longText })

      expect(report.sent).toBe(1)
      const [, body] = instance.pushToChat.mock.calls[0]
      expect(body.length).toBeLessThanOrEqual(5000)
      expect(body.startsWith('a'.repeat(4000))).toBe(true)
      expect(body.endsWith('(truncated, see Halo for full content)')).toBe(true)
    })
  })

  describe('per-session skip / failure paths', () => {
    it('skips when instance is not found in the manager', async () => {
      const session = makeSession({ instanceId: 'missing' })
      mockGetProactiveSessions.mockReturnValue([session])
      mockGetInstance.mockReturnValue(undefined)

      const report = await autoSyncRunResult({ ...baseInput, finalText: 'hi' })

      expect(report).toEqual({ subscribed: 1, sent: 0, skipped: 1, failed: 0 })
    })

    it('skips when instance is disconnected', async () => {
      const session = makeSession()
      const instance = makeInstance({ connected: false })
      mockGetProactiveSessions.mockReturnValue([session])
      mockGetInstance.mockReturnValue(instance)

      const report = await autoSyncRunResult({ ...baseInput, finalText: 'hi' })

      expect(report).toEqual({ subscribed: 1, sent: 0, skipped: 1, failed: 0 })
      expect(instance.pushToChat).not.toHaveBeenCalled()
    })

    it('counts a failed push when pushToChat returns false', async () => {
      const session = makeSession()
      const instance = makeInstance({ pushReturns: false })
      mockGetProactiveSessions.mockReturnValue([session])
      mockGetInstance.mockReturnValue(instance)

      const report = await autoSyncRunResult({ ...baseInput, finalText: 'hi' })

      expect(report).toEqual({ subscribed: 1, sent: 0, skipped: 0, failed: 1 })
    })

    it('isolates a thrown push from other sessions', async () => {
      const s1 = makeSession({ chatId: 'chat-a' })
      const s2 = makeSession({ chatId: 'chat-b' })
      const s3 = makeSession({ chatId: 'chat-c' })
      mockGetProactiveSessions.mockReturnValue([s1, s2, s3])

      const goodInstance = makeInstance()
      const badInstance = {
        isConnected: vi.fn().mockReturnValue(true),
        pushToChat: vi.fn().mockImplementation(() => {
          throw new Error('transport blew up')
        }),
      }
      let n = 0
      mockGetInstance.mockImplementation(() => (++n === 2 ? badInstance : goodInstance))

      const report = await autoSyncRunResult({ ...baseInput, finalText: 'hi' })

      expect(report).toEqual({ subscribed: 3, sent: 2, skipped: 0, failed: 1 })
    })
  })

  describe('per-chat-type dispatch', () => {
    it('forwards chatType direct to pushToChat', async () => {
      const session = makeSession({ chatType: 'direct' })
      const instance = makeInstance()
      mockGetProactiveSessions.mockReturnValue([session])
      mockGetInstance.mockReturnValue(instance)

      await autoSyncRunResult({ ...baseInput, finalText: 'hi' })

      expect(instance.pushToChat).toHaveBeenCalledOnce()
      expect(instance.pushToChat).toHaveBeenCalledWith('chat-1', 'hi', 'direct')
    })
  })
})
