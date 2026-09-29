/**
 * Unit tests for the terminal ANSI palettes.
 *
 * Guardrails against a palette edit silently reopening #267 / #276:
 * palette completeness, light-theme pair separation (xterm's contrast lifting
 * converges authored colours on screen, so separation must be authored in
 * natively), and dark palette parity with xterm's defaults.
 */

import { describe, it, expect } from 'vitest'
import { LIGHT_ANSI, DARK_ANSI } from '../../../src/renderer/lib/terminal-theme'

const ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
  'brightMagenta', 'brightCyan', 'brightWhite',
] as const

function srgb(c: number): number {
  c /= 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function relLuminance(hex: string): number {
  return (
    0.2126 * srgb(parseInt(hex.slice(1, 3), 16)) +
    0.7152 * srgb(parseInt(hex.slice(3, 5), 16)) +
    0.0722 * srgb(parseInt(hex.slice(5, 7), 16))
  )
}

/** WCAG contrast ratio. */
function contrast(a: string, b: string): number {
  const l1 = relLuminance(a)
  const l2 = relLuminance(b)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

function toLab(hex: string): [number, number, number] {
  const r = srgb(parseInt(hex.slice(1, 3), 16))
  const g = srgb(parseInt(hex.slice(3, 5), 16))
  const b = srgb(parseInt(hex.slice(5, 7), 16))
  let x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
  let y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  let z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  x = f(x); y = f(y); z = f(z)
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
}

/** CIE76 colour difference; below ~2.3 is under the just-noticeable difference. */
function deltaE(a: string, b: string): number {
  const A = toLab(a)
  const B = toLab(b)
  return Math.sqrt((A[0] - B[0]) ** 2 + (A[1] - B[1]) ** 2 + (A[2] - B[2]) ** 2)
}

/** Light-theme --card (globals.css `.light`), the surface terminals render on. */
const LIGHT_BG = '#fafafa'

describe('terminal ANSI palettes', () => {
  it('both palettes carry exactly the 16 ANSI slots', () => {
    expect(Object.keys(LIGHT_ANSI).sort()).toEqual([...ANSI_KEYS].sort())
    expect(Object.keys(DARK_ANSI).sort()).toEqual([...ANSI_KEYS].sort())
  })

  it('light: yellow/brightYellow and brightBlack/brightWhite stay distinguishable', () => {
    for (const [a, b] of [
      [LIGHT_ANSI.yellow, LIGHT_ANSI.brightYellow],
      [LIGHT_ANSI.brightBlack, LIGHT_ANSI.brightWhite],
    ] as const) {
      expect(deltaE(a, b)).toBeGreaterThan(2.3)
    }
  })

  it('light: the pre-darkened slots clear 4.5:1 natively (no lifting, normal or DIM)', () => {
    for (const hex of [
      LIGHT_ANSI.yellow, LIGHT_ANSI.brightYellow,
      LIGHT_ANSI.brightBlack, LIGHT_ANSI.brightWhite,
    ] as const) {
      expect(contrast(hex, LIGHT_BG)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('light: grey ramp is monotonically lighter black → white → brightBlack → brightWhite', () => {
    const ramp = [
      LIGHT_ANSI.black, LIGHT_ANSI.white,
      LIGHT_ANSI.brightBlack, LIGHT_ANSI.brightWhite,
    ] as const
    const lightness = ramp.map((hex) => toLab(hex)[0])
    for (let i = 1; i < lightness.length; i++) {
      expect(lightness[i]).toBeGreaterThan(lightness[i - 1])
    }
  })

  it('dark: palette equals xterm DEFAULT_ANSI_COLORS (Tango)', () => {
    // xterm@5.5.0 lib/xterm.js DEFAULT_ANSI_COLORS, verbatim (not exported).
    expect({ ...DARK_ANSI }).toEqual({
      black: '#2e3436', red: '#cc0000', green: '#4e9a06', yellow: '#c4a000',
      blue: '#3465a4', magenta: '#75507b', cyan: '#06989a', white: '#d3d7cf',
      brightBlack: '#555753', brightRed: '#ef2929', brightGreen: '#8ae234',
      brightYellow: '#fce94f', brightBlue: '#729fcf', brightMagenta: '#ad7fa8',
      brightCyan: '#34e2e2', brightWhite: '#eeeeec',
    })
  })
})
