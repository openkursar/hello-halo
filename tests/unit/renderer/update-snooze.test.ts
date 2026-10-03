/**
 * Deferring the update prompt: it lapses after a fixed span, stays tied to the
 * version it was given for, and never hides an update because of a record it
 * cannot read.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const persisted = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => persisted.get(key) ?? null,
  setItem: (key: string, value: string) => { persisted.set(key, value) },
  removeItem: (key: string) => { persisted.delete(key) },
})

const {
  UPDATE_SNOOZE_DURATION_MS,
  clearUpdateSnooze,
  isUpdateSnoozed,
  snoozeUpdate,
} = await import('../../../src/renderer/services/update-snooze')

const NOW = Date.UTC(2026, 8, 29, 1, 0, 0)

describe('update snooze', () => {
  beforeEach(() => {
    persisted.clear()
  })

  it('defers the prompt for the snoozed version until the span elapses', () => {
    snoozeUpdate('3.0.1', NOW)

    expect(isUpdateSnoozed('3.0.1', NOW)).toBe(true)
    expect(isUpdateSnoozed('3.0.1', NOW + UPDATE_SNOOZE_DURATION_MS - 1)).toBe(true)
    expect(isUpdateSnoozed('3.0.1', NOW + UPDATE_SNOOZE_DURATION_MS)).toBe(false)
  })

  it('does not carry a deferral over to a newer version', () => {
    snoozeUpdate('3.0.1', NOW)

    expect(isUpdateSnoozed('3.0.2', NOW)).toBe(false)
  })

  it('lifts the deferral when cleared', () => {
    snoozeUpdate('3.0.1', NOW)
    clearUpdateSnooze()

    expect(isUpdateSnoozed('3.0.1', NOW)).toBe(false)
  })

  it('ignores a record written in the earlier date-based format', () => {
    persisted.set('halo-update-snooze', '3.0.1|2026-09-29')

    expect(isUpdateSnoozed('3.0.1', NOW)).toBe(false)
  })

  it('ignores an expiry the clock could not have produced', () => {
    snoozeUpdate('3.0.1', NOW)

    expect(isUpdateSnoozed('3.0.1', NOW - 60 * 60 * 1000)).toBe(false)
  })

  it('treats unavailable storage as not deferred', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
      removeItem: () => { throw new Error('denied') },
    })
    try {
      expect(() => snoozeUpdate('3.0.1', NOW)).not.toThrow()
      expect(() => clearUpdateSnooze()).not.toThrow()
      expect(isUpdateSnoozed('3.0.1', NOW)).toBe(false)
    } finally {
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => persisted.get(key) ?? null,
        setItem: (key: string, value: string) => { persisted.set(key, value) },
        removeItem: (key: string) => { persisted.delete(key) },
      })
    }
  })
})
