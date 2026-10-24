/**
 * The renderer entry hands errors to the app once its modules have run, before
 * the language in use has loaded: an error while that loads must not be taken
 * for a failed start and cover the app with index.html's "failed to start" page.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

const entry = vi.hoisted(() => {
  let finishLoading: () => void = () => {}
  const i18nReady = new Promise<void>((resolve) => {
    finishLoading = resolve
  })
  return { i18nReady, finishLoading: () => finishLoading(), render: vi.fn() }
})

vi.mock('../../../src/renderer/i18n', () => ({ i18nReady: entry.i18nReady }))
vi.mock('../../../src/renderer/App', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/ErrorBoundary', () => ({ ErrorBoundary: () => null }))
vi.mock('../../../src/renderer/api/safe-area', () => ({ initCapacitorMobileShell: async () => {} }))
vi.mock('../../../src/renderer/lib/scrollbar-reveal', () => ({ initScrollbarReveal: () => {} }))
vi.mock('react-dom/client', () => ({ default: { createRoot: () => ({ render: entry.render }) } }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('renderer entry', () => {
  it('marks the app as handling errors before the language has loaded, then renders', async () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('document', { getElementById: () => ({}) })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await import('../../../src/renderer/main')
    expect((window as { __HALO_APP_MOUNTED__?: boolean }).__HALO_APP_MOUNTED__).toBe(true)
    expect(entry.render).not.toHaveBeenCalled()

    entry.finishLoading()
    await vi.waitFor(() => expect(entry.render).toHaveBeenCalledTimes(1))
  })
})
