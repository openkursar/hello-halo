/**
 * The "Other" capabilities group opens by default while web search is off,
 * and one person's open/closed pick does not carry over to the next person
 * shown in the same panel.
 */

import { describe, expect, it } from 'vitest'
import { isOtherGroupOpen } from '../../../src/renderer/components/apps/AppCapabilitiesSection'

describe('isOtherGroupOpen', () => {
  it('opens by default only while web search is off', () => {
    expect(isOtherGroupOpen(null, 'a', false)).toBe(true)
    expect(isOtherGroupOpen(null, 'a', true)).toBe(false)
  })

  it('follows the pick made for the same person', () => {
    expect(isOtherGroupOpen({ appId: 'a', open: false }, 'a', false)).toBe(false)
    expect(isOtherGroupOpen({ appId: 'a', open: true }, 'a', true)).toBe(true)
  })

  it('ignores a pick made for another person', () => {
    expect(isOtherGroupOpen({ appId: 'a', open: false }, 'b', false)).toBe(true)
    expect(isOtherGroupOpen({ appId: 'a', open: true }, 'b', true)).toBe(false)
  })
})
