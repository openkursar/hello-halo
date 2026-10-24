/**
 * What the language pickers show (first-run preferences, login, Settings →
 * Appearance): the language in use, including one the app switches to by
 * itself when the startup language arrives after it started in English; a
 * pick at once, while its translations load; the language in use again after
 * a pick that failed; and the last of overlapping picks.
 *
 * Components are called as functions with their state kept between calls, the
 * way React keeps it between renders; React re-renders a component when a store
 * it subscribed to tells it of a change, and here that is the next call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SUPPORTED_LOCALES, type LocaleCode } from '../../../src/renderer/i18n/locale'

const env = vi.hoisted(() => ({ runner: null as unknown as HookRunner }))

class HookRunner {
  values: unknown[] = []
  index = 0
  /** Changes the subscribed stores told of; React re-renders on each. */
  notices = 0
  state(initial: unknown) {
    const index = this.index++
    if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
    return [this.values[index], (update: unknown) => {
      this.values[index] = typeof update === 'function' ? (update as (value: unknown) => unknown)(this.values[index]) : update
    }]
  }
  /** Runs an effect when its dependencies change, like React after a render. */
  effect(run: () => void, deps?: readonly unknown[]) {
    const index = this.index++
    const previous = this.values[index] as readonly unknown[] | undefined
    if (previous && deps && deps.every((dep, i) => Object.is(dep, previous[i]))) return
    this.values[index] = deps
    run()
  }
  /** Subscribes once, as React does on mount. */
  store(subscribe: (onChange: () => void) => () => void, snapshot: () => unknown) {
    const index = this.index++
    if (!(index in this.values)) this.values[index] = subscribe(() => { this.notices++ })
    return snapshot()
  }
  render<T>(component: () => T): T {
    this.index = 0
    env.runner = this
    return component()
  }
}

vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => env.runner.state(initial),
  useEffect: (run: () => void, deps?: readonly unknown[]) => env.runner.effect(run, deps),
  useMemo: (compute: () => unknown) => compute(),
  useCallback: (callback: unknown) => callback,
  useSyncExternalStore: (subscribe: (onChange: () => void) => () => void, snapshot: () => unknown) => env.runner.store(subscribe, snapshot),
}))
vi.mock('react-i18next', async () => {
  const i18next = (await import('i18next')).default
  return {
    initReactI18next: { type: '3rdParty', init: () => {} },
    useTranslation: () => ({ t: i18next.t.bind(i18next), i18n: i18next }),
  }
})
vi.mock('../../../src/renderer/api', () => ({
  api: {
    authGetProviders: async () => ({ success: true, data: [{ type: 'custom', displayName: 'Custom API', description: 'Use your own API Key', enabled: true }] }),
    setConfig: async () => ({ success: true }),
    openExternal: async () => {},
    isRemoteMode: () => true,
  },
}))
vi.mock('../../../src/renderer/stores/app.store', () => ({
  useAppStore: () => ({ config: { appearance: { theme: 'system' } }, setConfig: () => {} }),
}))

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

/** Registered per test: a registered mock keeps its module across vi.resetModules(). */
function mockChunks(): void {
  for (const locale of ['zh-CN', 'ja', 'de', 'fr', 'es']) {
    vi.doMock(`../../../src/renderer/i18n/locales/${locale}.json`, async () => {
      await gate(locale).promise
      return { default: { Language: `${locale}: Language` } }
    })
  }
}

const LOCALE_KEY = 'halo-locale'
let saved: Map<string, string>

/** The app started with `savedLocale` picked earlier; English when that language is still loading after 3 s. */
async function start(savedLocale?: LocaleCode) {
  if (savedLocale) saved.set(LOCALE_KEY, savedLocale)
  const i18nModule = await import('../../../src/renderer/i18n')
  await vi.advanceTimersByTimeAsync(3000)
  await i18nModule.i18nReady
  return i18nModule.default
}

/** Lets mocked chunk imports and the handlers waiting on them settle; that needs real event-loop turns. */
async function settle(done: () => boolean = () => false): Promise<void> {
  for (let turn = 0; turn < 50 && !done(); turn++) await new Promise((resolve) => setImmediate(resolve))
}

interface Element {
  type: unknown
  key: string | null
  props: Record<string, unknown>
}

function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!node || typeof node !== 'object' || !('props' in node)) return []
  const element = node as Element
  return [element, ...elements(element.props.children)]
}

const strings = (element: Element): string[] => elements(element).flatMap((el) => [el.props.children].flat()).filter((child): child is string => typeof child === 'string')

const LOCALE_NAMES = new Set<string>(Object.values(SUPPORTED_LOCALES))

/** A mounted picker: what it shows, and picking from it as the user would. */
interface Picker {
  /** The language name it shows, and in brackets the languages it marks in its list. */
  shows(): string
  pick(locale: LocaleCode): void
  render(): unknown
  /** Changes it was told of, each one a re-render in React. */
  notices(): number
}

/** A button showing the language, opening a list to pick from. */
function dropdownPicker(view: () => unknown): Picker {
  const runner = new HookRunner()
  const render = () => runner.render(view)
  const toggle = (tree: unknown) => {
    const button = elements(tree).find((el) => el.type === 'button' && strings(el).some((text) => LOCALE_NAMES.has(text)))!
    ;(button.props.onClick as () => void)()
  }
  return {
    render,
    notices: () => runner.notices,
    shows() {
      const closed = render()
      const name = elements(closed).flatMap(strings).find((text) => LOCALE_NAMES.has(text))
      toggle(closed)
      const marked = elements(render())
        .filter((el) => el.type === 'button' && el.key && el.key in SUPPORTED_LOCALES && String(el.props.className).includes('text-primary'))
        .map((el) => el.key)
      toggle(render())
      return `${name} [${marked.join(', ')}]`
    },
    pick(locale) {
      toggle(render())
      const item = elements(render()).find((el) => el.type === 'button' && el.key === locale)!
      ;(item.props.onClick as () => void)()
    },
  }
}

/** A select element. */
function selectPicker(view: () => unknown): Picker {
  const runner = new HookRunner()
  const render = () => runner.render(view)
  const select = () => elements(render()).find((el) => el.type === 'select')!
  return {
    render,
    notices: () => runner.notices,
    shows() {
      const value = select().props.value as LocaleCode
      return `${SUPPORTED_LOCALES[value]} [${value}]`
    },
    pick(locale) {
      ;(select().props.onChange as (event: { target: { value: string } }) => void)({ target: { value: locale } })
    },
  }
}

async function mountLogin(): Promise<Picker> {
  const { LoginSelector } = await import('../../../src/renderer/components/setup/LoginSelector')
  return dropdownPicker(() => LoginSelector({ onSelectProvider: () => {}, onSelectPreset: () => {}, onSelectCustom: () => {} }))
}

const PICKERS: Array<[string, () => Promise<Picker>]> = [
  ['first-run preferences', async () => {
    const { PreferencesStep } = await import('../../../src/renderer/components/setup/PreferencesStep')
    return dropdownPicker(() => PreferencesStep({ onContinue: () => {} }))
  }],
  ['login', mountLogin],
  ['Settings → Appearance', async () => {
    const { AppearanceSection } = await import('../../../src/renderer/components/settings/AppearanceSection')
    return selectPicker(() => AppearanceSection({ config: null, setConfig: () => {} }))
  }],
]

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
  // i18next logs every step in a dev build, which a test is.
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe.each(PICKERS)('the %s language picker', (_name, mount) => {
  it('shows the language the app switches to by itself when the startup language arrives late', async () => {
    const i18n = await start('zh-CN')
    const picker = await mount()
    expect(picker.shows()).toBe('English [en]')

    gate('zh-CN').open()
    await settle(() => i18n.language === 'zh-CN')
    expect(i18n.language).toBe('zh-CN')
    expect(picker.shows()).toBe('简体中文 [zh-CN]')
    expect(picker.notices(), 'the picker is told of the switch, so React re-renders it').toBeGreaterThan(0)
  })

  it('shows a pick at once, the language in use after a pick that failed, and the last of overlapping picks', async () => {
    const i18n = await start()
    const picker = await mount()

    gate('ja').open()
    picker.pick('ja')
    expect(picker.shows()).toBe('日本語 [ja]')
    await settle(() => i18n.language === 'ja')
    expect(picker.shows()).toBe('日本語 [ja]')

    gate('fr').fail()
    picker.pick('fr')
    expect(picker.shows()).toBe('Français [fr]')
    await settle()
    expect(i18n.language).toBe('ja')
    expect(picker.shows()).toBe('日本語 [ja]')

    picker.pick('es')
    picker.pick('de')
    gate('es').open()
    await settle()
    expect(picker.shows(), 'an earlier pick finishing first').toBe('Deutsch [de]')
    gate('de').open()
    await settle(() => i18n.language === 'de')
    expect(picker.shows()).toBe('Deutsch [de]')

    picker.pick('zh-CN')
    expect(picker.shows()).toBe('简体中文 [zh-CN]')
    await vi.advanceTimersByTimeAsync(3000)
    await settle()
    expect(i18n.language).toBe('de')
    expect(picker.shows(), 'a pick that timed out').toBe('Deutsch [de]')
  })
})

describe('the login page', () => {
  it('orders the API vendors for the language the app switches to by itself', async () => {
    const i18n = await start('zh-CN')
    const login = await mountLogin()
    const vendors = (tree: unknown) => elements(tree).filter((el) => el.type === 'span' && el.key).map((el) => el.key)
    login.render()
    await settle()
    const english = vendors(login.render())

    gate('zh-CN').open()
    await settle(() => i18n.language === 'zh-CN')
    const startedInChinese = await mountLogin()
    startedInChinese.render()
    await settle()
    const chinese = vendors(startedInChinese.render())

    expect(english, 'the case needs vendors that a Chinese page lists first').not.toEqual(chinese)
    expect(vendors(login.render())).toEqual(chinese)
  })
})
