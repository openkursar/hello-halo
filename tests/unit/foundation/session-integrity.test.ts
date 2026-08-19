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
  markSessionCleanExit,
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
