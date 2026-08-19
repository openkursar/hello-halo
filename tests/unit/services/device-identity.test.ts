/**
 * Device Identity unit tests.
 *
 * Covers generation, persistence, and strict regeneration on structurally
 * invalid persisted state (the identity guards the permanent remote-access
 * hostname, so validation must never be lenient).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

let store: Record<string, unknown> = {}

vi.mock('../../../src/main/foundation/config.service', () => ({
  getConfig: vi.fn(() => store),
  saveConfig: vi.fn((partial: Record<string, unknown>) => {
    store = { ...store, ...partial }
    return store
  }),
}))

import { getDeviceIdentity } from '../../../src/main/foundation/device-identity'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('device-identity', () => {
  beforeEach(() => {
    store = {}
    vi.clearAllMocks()
  })

  it('generates a valid identity on first access and persists it', () => {
    const identity = getDeviceIdentity()
    expect(identity.deviceId).toMatch(UUID_RE)
    expect(identity.deviceSecret).toMatch(/^[0-9a-f]{64}$/)
    expect(store.deviceIdentity).toEqual(identity)
  })

  it('returns the same identity on subsequent calls', () => {
    const first = getDeviceIdentity()
    const second = getDeviceIdentity()
    expect(second).toEqual(first)
  })

  it.each([
    ['invalid uuid', { deviceId: 'not-a-uuid', deviceSecret: 'a'.repeat(64) }],
    ['short secret', { deviceId: '74b24652-1dac-4ab4-9a41-6d94d0f8624c', deviceSecret: 'short' }],
    ['missing secret', { deviceId: '74b24652-1dac-4ab4-9a41-6d94d0f8624c' }],
  ])('regenerates when the persisted identity has %s', (_label, bad) => {
    store.deviceIdentity = bad
    const identity = getDeviceIdentity()
    expect(identity.deviceId).toMatch(UUID_RE)
    expect(identity.deviceSecret).toMatch(/^[0-9a-f]{64}$/)
    expect(store.deviceIdentity).toEqual(identity)
  })
})
