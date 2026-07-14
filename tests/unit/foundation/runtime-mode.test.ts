/**
 * runtime-mode unit tests.
 *
 * Covers isServerMode flag parsing and getServerPort precedence
 * (PORT over HALO_SERVER_PORT) with fallback to 8080 for invalid input.
 */

import { describe, it, expect, beforeEach } from 'vitest'

import { isServerMode, getServerPort } from '../../../src/main/foundation/runtime-mode'

describe('runtime-mode', () => {
  beforeEach(() => {
    delete process.env.HALO_SERVER_MODE
    delete process.env.PORT
    delete process.env.HALO_SERVER_PORT
  })

  describe('isServerMode', () => {
    it('is true for "1"', () => {
      process.env.HALO_SERVER_MODE = '1'
      expect(isServerMode()).toBe(true)
    })

    it('is true for "true"', () => {
      process.env.HALO_SERVER_MODE = 'true'
      expect(isServerMode()).toBe(true)
    })

    it('is false for any other value', () => {
      process.env.HALO_SERVER_MODE = 'yes'
      expect(isServerMode()).toBe(false)
    })

    it('is false when unset', () => {
      expect(isServerMode()).toBe(false)
    })
  })

  describe('getServerPort', () => {
    it('honors PORT over HALO_SERVER_PORT', () => {
      process.env.PORT = '3000'
      process.env.HALO_SERVER_PORT = '9000'
      expect(getServerPort()).toBe(3000)
    })

    it('falls back to HALO_SERVER_PORT when PORT is absent', () => {
      process.env.HALO_SERVER_PORT = '9000'
      expect(getServerPort()).toBe(9000)
    })

    it('defaults to 8080 when both are unset', () => {
      expect(getServerPort()).toBe(8080)
    })

    it('defaults to 8080 for a non-numeric value', () => {
      process.env.PORT = 'abc'
      expect(getServerPort()).toBe(8080)
    })

    it('defaults to 8080 for a negative value', () => {
      process.env.PORT = '-5'
      expect(getServerPort()).toBe(8080)
    })
  })
})
