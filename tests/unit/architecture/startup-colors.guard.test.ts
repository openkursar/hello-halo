/**
 * Before globals.css has loaded, three places draw with literal copies of its
 * theme tokens: the native window (main process), index.html's anti-flash
 * background and the boot splash's fallbacks. A copy that drifts from the
 * token shows the wrong color for the first moments of every launch.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { THEME_WINDOW_COLORS } from '../../../src/main/foundation/window-startup'

const root = resolve(__dirname, '../../..')
const globalsCss = readFileSync(resolve(root, 'src/renderer/assets/styles/globals.css'), 'utf-8')
const indexHtml = readFileSync(resolve(root, 'src/renderer/index.html'), 'utf-8')

type Theme = 'dark' | 'light'

/** The first rule block for `selector` (dark is `:root`, light is `.light`). */
function block(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`no "${selector} {" block`)
  return source.slice(start, source.indexOf('}', start))
}

function token(theme: Theme, name: string): string {
  const value = new RegExp(`--${name}:\\s*([^;]+);`).exec(block(globalsCss, theme === 'dark' ? ':root' : '.light'))?.[1]
  if (!value) throw new Error(`globals.css has no --${name} for ${theme}`)
  return value.trim()
}

/** Same conversion App.tsx's applyTheme uses for the live caption-button strip. */
function hslToHex(hsl: string): string {
  const [h, s, l] = hsl.split(/\s+/).map(v => parseFloat(v))
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100)
  const channel = (n: number) => {
    const k = (n + h / 30) % 12
    const v = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(255 * v).toString(16).padStart(2, '0')
  }
  return `#${channel(0)}${channel(8)}${channel(4)}`
}

describe('startup colors guard', () => {
  it.each<Theme>(['dark', 'light'])('the native window starts in the %s theme\'s colors', theme => {
    expect(THEME_WINDOW_COLORS[theme]).toEqual({
      background: hslToHex(token(theme, 'background')),
      symbol: hslToHex(token(theme, 'foreground')),
    })
  })

  it('index.html paints the page background before globals.css loads', () => {
    expect(indexHtml).toContain(`html, body, #root { background-color: ${hslToHex(token('dark', 'background'))}; }`)
    expect(indexHtml).toContain(
      `html.light, html.light body, html.light #root { background-color: ${hslToHex(token('light', 'background'))}; }`,
    )
  })

  it.each<Theme>(['dark', 'light'])('the boot splash falls back to the %s theme\'s tokens', theme => {
    const splash = block(indexHtml, theme === 'dark' ? '#boot-splash' : 'html.light #boot-splash')
    const fallbacks = [...splash.matchAll(/var\(--([\w-]+),\s*([^)]+)\)/g)]
    expect(fallbacks.length).toBeGreaterThan(0)
    for (const [, name, fallback] of fallbacks) {
      expect(`${name}: ${fallback.trim()}`).toBe(`${name}: ${token(theme, name)}`)
    }
  })
})
