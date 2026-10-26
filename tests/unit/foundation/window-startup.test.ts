import { describe, expect, it } from 'vitest'
import { startupWindowColors, THEME_WINDOW_COLORS } from '../../../src/main/foundation/window-startup'

describe('startupWindowColors', () => {
  it('follows an explicit theme regardless of the system', () => {
    expect(startupWindowColors('dark', false)).toEqual(THEME_WINDOW_COLORS.dark)
    expect(startupWindowColors('light', true)).toEqual(THEME_WINDOW_COLORS.light)
  })

  it('follows the system for "system" and when no theme is saved', () => {
    expect(startupWindowColors('system', true)).toEqual(THEME_WINDOW_COLORS.dark)
    expect(startupWindowColors('system', false)).toEqual(THEME_WINDOW_COLORS.light)
    expect(startupWindowColors(undefined, false)).toEqual(THEME_WINDOW_COLORS.light)
  })
})
