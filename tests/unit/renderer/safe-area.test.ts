/**
 * The phone app's page keeps clear of the status bar: it marks itself so the
 * layout applies the insets at any width, and when it starts before native
 * code has written the status bar height it asks Android for it once (no
 * polling). From Android 15 on the system's own plugin owns the value; iOS,
 * browsers and the desktop app never ask.
 */

import { readFileSync } from 'node:fs'
import { parse, type Declaration, type Rule } from 'postcss'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  capacitor: true,
  platform: 'android',
  getInsets: (async () => ({})) as (...args: unknown[]) => Promise<{ top?: number }>,
}))

vi.mock('../../../src/renderer/api/transport', () => ({ isCapacitor: () => env.capacitor }))
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => env.platform },
  registerPlugin: () => ({ getInsets: (...args: unknown[]) => env.getInsets(...args) }),
}))
vi.mock('@capacitor/status-bar', () => ({ StatusBar: { setOverlaysWebView: async () => {}, setStyle: async () => {} } }))

const TOP = '--safe-area-inset-top'
let style: Map<string, string>
let classes: Set<string>
let getInsets: ReturnType<typeof vi.fn<unknown[], Promise<{ top?: number }>>>

beforeEach(() => {
  env.capacitor = true
  env.platform = 'android'
  getInsets = vi.fn<unknown[], Promise<{ top?: number }>>(async () => ({ top: 28 }))
  env.getInsets = getInsets
  style = new Map()
  classes = new Set()
  vi.stubGlobal('document', {
    documentElement: {
      style: { getPropertyValue: (name: string) => style.get(name) ?? '', setProperty: (name: string, value: string) => { style.set(name, value) } },
      classList: { add: (name: string) => { classes.add(name) } },
    },
  })
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Starts the shell the way main.tsx does and lets its single question settle. */
async function start(): Promise<void> {
  const { initCapacitorMobileShell } = await import('../../../src/renderer/api/safe-area')
  await initCapacitorMobileShell()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

it('marks the page as the phone app, so the layout keeps clear of the system bars at any width', async () => {
  await start()
  expect(classes.has('platform-capacitor')).toBe(true)
})

it('asks Android once for the status bar height when the page starts without it', async () => {
  await start()
  expect(getInsets).toHaveBeenCalledTimes(1)
  expect(style.get(TOP)).toBe('28px')
})

it('asks nothing when native code already wrote the height', async () => {
  style.set(TOP, '24px')
  await start()
  expect(getInsets).not.toHaveBeenCalled()
  expect(style.get(TOP)).toBe('24px')
})

it('keeps the height native code wrote while the answer was on its way', async () => {
  env.getInsets = async () => {
    style.set(TOP, '30px')
    return { top: 28 }
  }
  await start()
  expect(style.get(TOP)).toBe('30px')
})

it('leaves the height to the system from Android 15 on', async () => {
  env.getInsets = async () => ({})
  await start()
  expect(style.has(TOP)).toBe(false)
})

it('never asks on iOS, which reports the insets itself', async () => {
  env.platform = 'ios'
  await start()
  expect(getInsets).not.toHaveBeenCalled()
  expect(style.has(TOP)).toBe(false)
})

it('does nothing in a browser or the desktop app', async () => {
  env.capacitor = false
  await start()
  expect(classes.size).toBe(0)
  expect(getInsets).not.toHaveBeenCalled()
})

it('logs a failed question and leaves the page as it was', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  env.getInsets = async () => { throw new Error('not implemented') }
  await start()
  expect(style.has(TOP)).toBe(false)
  expect(warn).toHaveBeenCalledWith('[SafeArea] Could not ask for the status bar height:', expect.any(Error))
})

it('the app\'s layout applies the insets at every width, so a phone turned sideways keeps clear too', () => {
  const css = parse(readFileSync(new URL('../../../src/renderer/assets/styles/globals.css', import.meta.url), 'utf8'))
  const rules: Rule[] = []
  css.walkRules('html.platform-capacitor #root', (rule) => { rules.push(rule) })
  expect(rules).toHaveLength(1)
  // Not inside the mobile breakpoint's media query.
  expect(rules[0].parent?.type).toBe('root')
  const value = (prop: string) => (rules[0].nodes.find((node) => node.type === 'decl' && node.prop === prop) as Declaration | undefined)?.value
  expect(['top', 'right', 'bottom', 'left'].map(value)).toEqual(['var(--sat)', 'var(--sar)', 'var(--sab)', 'var(--sal)'])
  // The wide layout's 100% size would push the inset box past the screen edge.
  expect([value('width'), value('height')]).toEqual(['auto', 'auto'])
})
