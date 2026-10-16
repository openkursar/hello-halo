import { readFileSync } from 'node:fs'
import { parse } from 'postcss'
import { describe, expect, it } from 'vitest'

type Rgb = [number, number, number]

const globals = parse(readFileSync(new URL('../../../src/renderer/assets/styles/globals.css', import.meta.url), 'utf8'))
const tailwind = readFileSync(new URL('../../../tailwind.config.cjs', import.meta.url), 'utf8')

function darkTokens(): Record<string, string> {
  const tokens: Record<string, string> = {}
  globals.walkRules(':root', rule => {
    rule.walkDecls(/^--/, decl => { tokens[decl.prop] = decl.value })
  })
  return tokens
}

function hslToRgb(value: string): Rgb {
  const match = /^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/.exec(value)
  if (!match) throw new Error(`Unsupported HSL token: ${value}`)
  const hue = Number(match[1]) / 30
  const saturation = Number(match[2]) / 100
  const lightness = Number(match[3]) / 100
  const amplitude = saturation * Math.min(lightness, 1 - lightness)
  return [0, 8, 4].map(offset => {
    const k = (hue + offset) % 12
    return lightness - amplitude * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }) as Rgb
}

function luminance(rgb: Rgb): number {
  const [red, green, blue] = rgb.map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrast(foreground: string, background: string): number {
  const a = luminance(hslToRgb(foreground))
  const b = luminance(hslToRgb(background))
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

describe('dark theme primary text contrast', () => {
  it('routes text-primary and prose links through the text token, not the fill', () => {
    expect(tailwind).toContain("primary: { DEFAULT: 'hsl(var(--primary-text))' }")
    expect(tailwind).toContain("'--tw-prose-invert-links': 'hsl(var(--primary-text))'")
  })

  it('clears WCAG AA on every surface primary text sits on', () => {
    const tokens = darkTokens()
    for (const surface of ['--background', '--card', '--popover', '--secondary', '--muted']) {
      expect(contrast(tokens['--primary-text'], tokens[surface]), surface).toBeGreaterThanOrEqual(4.5)
    }
  })
})
