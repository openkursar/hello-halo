/**
 * Where the macOS traffic lights sit: unchanged up to macOS 15, moved in from
 * the larger window corner on macOS 26 and later.
 */

import { describe, expect, it } from 'vitest'
import { macTrafficLightGeometry } from '../../../src/shared/constants/mac-traffic-lights'

describe('macTrafficLightGeometry', () => {
  it.each(['11.7.10', '14.5.0', '15.6.1', undefined, ''])('keeps the established position on %s', version => {
    expect(macTrafficLightGeometry(version)).toEqual({ position: { x: 5, y: 8 }, bottom: 22 })
  })

  it.each(['26.0.0', '26.1', '27.0.0'])('moves the buttons in from the corner on %s', version => {
    const geometry = macTrafficLightGeometry(version)
    expect(geometry.position).toEqual({ x: 8, y: 10 })
    expect(geometry.bottom).toBe(24)
  })
})
