/**
 * index.html's anti-flash script picks the theme of the page's first frame
 * before any app code runs.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { runInNewContext } from 'vm'

const indexHtml = readFileSync(resolve(__dirname, '../../../src/renderer/index.html'), 'utf-8')
const antiFlashScript = /<script>\s*\/\/ Anti-flash: apply theme before render[\s\S]*?<\/script>/.exec(indexHtml)?.[0]
  .replace(/^<script>/, '')
  .replace(/<\/script>$/, '')

interface Boot {
  /** The theme the main process passed when it created the window. */
  bootTheme?: string
  stored?: string
  navigation?: 'navigate' | 'reload'
  systemDark?: boolean
}

function boot({ bootTheme, stored, navigation, systemDark = true }: Boot) {
  if (!antiFlashScript) throw new Error('anti-flash script not found in index.html')
  const storage = new Map<string, string>(stored ? [['halo-theme', stored]] : [])
  const classes = new Set<string>()
  runInNewContext(antiFlashScript, {
    window: { haloBootTheme: bootTheme, matchMedia: () => ({ matches: systemDark }) },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    performance: { getEntriesByType: () => (navigation ? [{ type: navigation }] : []) },
    document: { documentElement: { classList: { add: (name: string) => classes.add(name) } } },
    navigator: { userAgent: 'Electron' },
  })
  return { theme: classes.has('light') ? 'light' : classes.has('theme-dark') ? 'dark' : 'none', stored: storage.get('halo-theme') }
}

describe('anti-flash theme', () => {
  it('a launch boots in the theme saved in config and brings the stored copy in line', () => {
    expect(boot({ bootTheme: 'light', stored: 'dark', navigation: 'navigate' })).toEqual({ theme: 'light', stored: 'light' })
  })

  it('a launch on an engine without navigation entries still uses the saved theme', () => {
    expect(boot({ bootTheme: 'light', stored: 'dark' })).toEqual({ theme: 'light', stored: 'light' })
  })

  it('a reload of the same window keeps the theme the user switched to since it was created', () => {
    expect(boot({ bootTheme: 'dark', stored: 'light', navigation: 'reload' })).toEqual({ theme: 'light', stored: 'light' })
  })

  it('a reload with nothing stored falls back to the theme passed at creation', () => {
    expect(boot({ bootTheme: 'light', navigation: 'reload' })).toEqual({ theme: 'light', stored: undefined })
  })

  it('a page without a desktop window (remote browser, mobile) uses the stored theme', () => {
    expect(boot({ stored: 'light', navigation: 'navigate' })).toEqual({ theme: 'light', stored: 'light' })
  })

  it('follows the system when the theme is "system" or nothing is known', () => {
    expect(boot({ bootTheme: 'system', navigation: 'navigate', systemDark: false }).theme).toBe('light')
    expect(boot({ navigation: 'navigate', systemDark: true }).theme).toBe('dark')
  })
})
