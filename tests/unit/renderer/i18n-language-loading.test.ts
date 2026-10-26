/**
 * Loading a language's translations: the first render waits at most a few
 * seconds and falls back to English, and a switch whose translations cannot be
 * loaded leaves the language in use and the saved choice as they were.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Gate {
  promise: Promise<void>
  open: () => void
  fail: () => void
}

/** Each language's chunk import waits for its gate: open it to load, fail it to make the import fail. */
const gates = new Map<string, Gate>()

function gate(locale: string): Gate {
  let found = gates.get(locale)
  if (!found) {
    let open = (): void => {}
    let fail = (): void => {}
    const promise = new Promise<void>((resolve, reject) => {
      open = resolve
      fail = () => reject(new Error(`${locale} chunk failed`))
    })
    // A gate can fail before the chunk's import awaits it.
    promise.catch(() => {})
    found = { promise, open, fail }
    gates.set(locale, found)
  }
  return found
}

const CHUNKS: Record<string, string> = { 'zh-CN': '设置', 'ja': '設定', 'de': 'Einstellungen', 'fr': 'Paramètres', 'es': 'Ajustes' }

/** Registered per test: a registered mock keeps its module across vi.resetModules(). */
function mockChunks(): void {
  for (const [locale, settings] of Object.entries(CHUNKS)) {
    vi.doMock(`../../../src/renderer/i18n/locales/${locale}.json`, async () => {
      await gate(locale).promise
      return { default: { Settings: settings } }
    })
  }
}

const LOCALE_KEY = 'halo-locale'
let saved: Map<string, string>

/** The app as it starts with `savedLocale` picked earlier (none: the system language, English here). */
async function start(savedLocale?: string) {
  if (savedLocale) saved.set(LOCALE_KEY, savedLocale)
  const i18nModule = await import('../../../src/renderer/i18n')
  const { switchLanguage } = await import('../../../src/renderer/services/language-switch')
  const { useNotificationStore } = await import('../../../src/renderer/stores/notification.store')
  return {
    i18n: i18nModule.default,
    i18nReady: i18nModule.i18nReady,
    switchLanguage,
    toasts: () => useNotificationStore.getState().toasts,
  }
}

/** Lets a mocked chunk import settle; module resolution needs real event-loop turns. */
async function settle(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 50 && !done(); turn++) await new Promise((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  vi.resetModules()
  gates.clear()
  mockChunks()
  saved = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => void saved.set(key, value),
    removeItem: (key: string) => void saved.delete(key),
  })
  vi.stubGlobal('navigator', { language: 'en-US' })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('starting in the saved language', () => {
  it('starts in English when the translations stall, and switches once they arrive', async () => {
    const app = await start('zh-CN')
    await vi.advanceTimersByTimeAsync(3000)
    await app.i18nReady
    expect(app.i18n.language).toBe('en')
    expect(saved.get(LOCALE_KEY)).toBe('zh-CN')

    gate('zh-CN').open()
    await settle(() => app.i18n.language === 'zh-CN')
    expect(app.i18n.language).toBe('zh-CN')
    expect(app.i18n.t('Settings')).toBe('设置')
  })

  it('starts in English when the translations fail, and keeps the saved choice for the next start', async () => {
    gate('zh-CN').fail()
    const app = await start('zh-CN')
    await app.i18nReady
    expect(app.i18n.language).toBe('en')
    expect(saved.get(LOCALE_KEY)).toBe('zh-CN')
  })

  it('keeps a language the user picked while the stalled one was still loading', async () => {
    const app = await start('zh-CN')
    await vi.advanceTimersByTimeAsync(3000)
    await app.i18nReady

    gate('ja').open()
    expect(await app.switchLanguage('ja')).toBe(true)
    gate('zh-CN').open()
    await settle(() => false)
    expect(app.i18n.language).toBe('ja')
    expect(saved.get(LOCALE_KEY)).toBe('ja')
  })
})

describe('switching languages', () => {
  it('switches and remembers the choice once the translations are in', async () => {
    const app = await start()
    await app.i18nReady
    gate('de').open()
    expect(await app.switchLanguage('de')).toBe(true)
    expect(app.i18n.language).toBe('de')
    expect(app.i18n.t('Settings')).toBe('Einstellungen')
    expect(saved.get(LOCALE_KEY)).toBe('de')
    expect(app.toasts()).toEqual([])
  })

  it('keeps the language in use and the saved choice when the translations fail, and says so', async () => {
    const app = await start()
    await app.i18nReady
    gate('ja').fail()
    expect(await app.switchLanguage('ja')).toBe(false)
    expect(app.i18n.language).toBe('en')
    expect(saved.has(LOCALE_KEY)).toBe(false)
    expect(app.toasts()).toMatchObject([{ id: 'language-switch-failed', title: "Couldn't switch to 日本語", variant: 'warning' }])
  })

  it('gives up on translations that stall, and ignores them when they arrive later', async () => {
    const app = await start()
    await app.i18nReady
    const switching = app.switchLanguage('de')
    await vi.advanceTimersByTimeAsync(3000)
    expect(await switching).toBe(false)
    expect(app.toasts()).toHaveLength(1)

    gate('de').open()
    await settle(() => false)
    expect(app.i18n.language).toBe('en')
    expect(saved.has(LOCALE_KEY)).toBe(false)
  })

  it('lets the last of overlapping switches win, without telling the user about the others', async () => {
    const app = await start()
    await app.i18nReady
    const first = app.switchLanguage('fr')
    gate('es').open()
    expect(await app.switchLanguage('es')).toBe(true)

    gate('fr').open()
    expect(await first).toBe(true)
    expect(app.i18n.language).toBe('es')
    expect(saved.get(LOCALE_KEY)).toBe('es')
    expect(app.toasts()).toEqual([])
  })
})
