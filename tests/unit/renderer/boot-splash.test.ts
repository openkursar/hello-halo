import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dismissBootSplash } from '../../../src/renderer/lib/boot-splash'

function fakeSplash() {
  const properties = new Map<string, string>()
  return {
    dataset: {} as Record<string, string>,
    style: {
      opacity: '',
      transition: '',
      pointerEvents: '',
      setProperty: (name: string, value: string) => properties.set(name, value),
    },
    properties,
    remove: vi.fn(),
  }
}

let splash: ReturnType<typeof fakeSplash> | null
let reducedMotion = false

beforeEach(() => {
  vi.useFakeTimers()
  splash = fakeSplash()
  reducedMotion = false
  vi.stubGlobal('document', { getElementById: (id: string) => (id === 'boot-splash' ? splash : null) })
  vi.stubGlobal('window', { matchMedia: () => ({ matches: reducedMotion }) })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('dismissBootSplash', () => {
  it('lets input through at once, fades the splash out, then removes it', () => {
    const el = splash!
    dismissBootSplash()
    expect(el.style.pointerEvents).toBe('none')
    expect(el.properties.get('-webkit-app-region')).toBe('no-drag')
    expect(el.style.opacity).toBe('0')
    expect(el.remove).not.toHaveBeenCalled()

    vi.runAllTimers()
    expect(el.remove).toHaveBeenCalledTimes(1)
  })

  it('removes it at once when the user asks for reduced motion', () => {
    reducedMotion = true
    const el = splash!
    dismissBootSplash()
    expect(el.remove).toHaveBeenCalledTimes(1)
  })

  it('does nothing more on later calls, or when there is no splash', () => {
    const el = splash!
    dismissBootSplash()
    dismissBootSplash()
    vi.runAllTimers()
    expect(el.remove).toHaveBeenCalledTimes(1)

    splash = null
    expect(() => dismissBootSplash()).not.toThrow()
  })
})

