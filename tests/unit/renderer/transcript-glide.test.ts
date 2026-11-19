/**
 * While a reply streams, the transcript glides to its new end instead of
 * jumping per burst: each frame covers a share of what is left, the same over
 * time at any frame rate, and it never overshoots.
 */

import { describe, expect, it } from 'vitest'
import { glideStep } from '../../../src/renderer/components/chat/transcript/useStickToBottom'

const FRAME = 1000 / 60

describe('glideStep', () => {
  it('covers a share of the distance per frame', () => {
    expect(glideStep(400, FRAME)).toBeCloseTo(100, 5)
  })

  it('moves as far over the same time at 120 Hz as at 60 Hz', () => {
    const first = glideStep(400, FRAME / 2)
    const second = glideStep(400 - first, FRAME / 2)
    expect(first + second).toBeCloseTo(glideStep(400, FRAME), 5)
  })

  it('keeps moving at a minimum pace near the end, and lands on it', () => {
    expect(glideStep(4, FRAME)).toBeCloseTo(1.5, 5)
    expect(glideStep(1.2, FRAME)).toBe(1.2)
  })

  it('catches up with a burst of text within a few hundred milliseconds', () => {
    let remaining = 120
    let elapsed = 0
    while (remaining > 1) {
      remaining -= glideStep(remaining, FRAME)
      elapsed += FRAME
    }
    expect(elapsed).toBeLessThan(300)
  })

  it('does not leap after a long pause between frames', () => {
    expect(glideStep(1000, 1000)).toBeLessThan(1000)
  })
})
