/**
 * session-integrity unit tests.
 *
 * Covers marker-based detection of ungraceful exit: present → warn + re-arm,
 * absent → clean + arm, unreadable marker is non-fatal, and markSessionCleanExit
 * is idempotent / no-op when the marker is absent.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}))

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import {
  checkAndArmSessionIntegrity,
  getPreviousSessionExit,
  markSessionCleanExit,
  recordSessionExitReason,
} from '../../../src/main/foundation/session-integrity'

type MockFn = ReturnType<typeof vi.fn>

const existsMock = existsSync as unknown as MockFn
const readMock = readFileSync as unknown as MockFn
const writeMock = writeFileSync as unknown as MockFn
const unlinkMock = unlinkSync as unknown as MockFn

describe('session-integrity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('checkAndArmSessionIntegrity', () => {
    it('marker present → warns and re-arms', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      existsMock.mockReturnValue(true)
      readMock.mockReturnValue('{"pid":1}')

      checkAndArmSessionIntegrity()

      expect(warn).toHaveBeenCalled()
      expect(writeMock).toHaveBeenCalledTimes(1)
      warn.mockRestore()
    })

    it('marker absent → clean and arms', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      existsMock.mockReturnValue(false)

      checkAndArmSessionIntegrity()

      expect(log).toHaveBeenCalledWith(expect.stringContaining('exited cleanly'))
      expect(writeMock).toHaveBeenCalledTimes(1)
      log.mockRestore()
    })

    it('marker carrying an exit reason → attributed to a relaunch, not a clean exit', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      existsMock.mockReturnValue(true)
      readMock.mockReturnValue(JSON.stringify({
        pid: 1, version: '9.9.9', exit: { reason: 'renderer-recovery', at: '2026-09-30T00:00:00.000Z' },
      }))

      const result = checkAndArmSessionIntegrity()

      expect(result).toEqual({ kind: 'relaunch', reason: 'renderer-recovery', previousVersion: '9.9.9' })
      expect(getPreviousSessionExit()).toEqual(result)
      // The re-armed marker for this session carries no inherited exit reason.
      const armed = JSON.parse(writeMock.mock.calls[0][1] as string)
      expect(armed.exit).toBeUndefined()
    })

    it('marker without a reason → unclean', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      existsMock.mockReturnValue(true)
      readMock.mockReturnValue('{"pid":1,"version":"1.2.3"}')

      expect(checkAndArmSessionIntegrity()).toEqual({ kind: 'unclean', previousVersion: '1.2.3' })
    })

    it('marker absent → reports clean', () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      existsMock.mockReturnValue(false)

      expect(checkAndArmSessionIntegrity()).toEqual({ kind: 'clean' })
    })

    it('unreadable marker is non-fatal and still re-arms', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      existsMock.mockReturnValue(true)
      readMock.mockImplementation(() => {
        throw new Error('EACCES')
      })

      expect(() => checkAndArmSessionIntegrity()).not.toThrow()
      expect(writeMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('recordSessionExitReason', () => {
    it('keeps the marker and adds the reason instead of removing it', () => {
      existsMock.mockReturnValue(true)
      readMock.mockReturnValue('{"pid":42,"version":"1.0.0"}')

      recordSessionExitReason('settings-restart')

      expect(unlinkMock).not.toHaveBeenCalled()
      const written = JSON.parse(writeMock.mock.calls[0][1] as string)
      expect(written.pid).toBe(42)
      expect(written.exit.reason).toBe('settings-restart')
    })

    it('writes a fresh marker when none exists', () => {
      existsMock.mockReturnValue(false)

      recordSessionExitReason('renderer-recovery')

      const written = JSON.parse(writeMock.mock.calls[0][1] as string)
      expect(written.exit.reason).toBe('renderer-recovery')
    })

    it('never throws when the write fails', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      existsMock.mockReturnValue(false)
      writeMock.mockImplementationOnce(() => { throw new Error('EROFS') })

      expect(() => recordSessionExitReason('x')).not.toThrow()
    })
  })

  describe('markSessionCleanExit', () => {
    it('removes the marker when present', () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      existsMock.mockReturnValue(true)

      markSessionCleanExit()

      expect(unlinkMock).toHaveBeenCalledTimes(1)
    })

    it('is a no-op when the marker is absent', () => {
      existsMock.mockReturnValue(false)

      markSessionCleanExit()

      expect(unlinkMock).not.toHaveBeenCalled()
    })

    it('is idempotent across repeated calls', () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      // First call: present → removed. Second call: now absent → no-op.
      existsMock.mockReturnValueOnce(true).mockReturnValueOnce(false)

      markSessionCleanExit()
      markSessionCleanExit()

      expect(unlinkMock).toHaveBeenCalledTimes(1)
    })
  })
})
