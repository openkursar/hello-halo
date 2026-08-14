/**
 * The `store.detail.view` side of the store funnel: one event per detail the
 * user actually reaches, counted from the action every entry point routes
 * through.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const trackEvent = vi.fn()
const storeGetAppDetail = vi.fn()

vi.mock('../../../src/renderer/api', () => ({
  api: {
    trackEvent,
    storeGetAppDetail: (slug: string) => storeGetAppDetail(slug),
    storeList: vi.fn(),
    storeInstall: vi.fn(),
    imSessionsList: vi.fn(),
  },
}))

vi.mock('../../../src/renderer/i18n', () => ({ getCurrentLanguage: () => 'en' }))

vi.mock('../../../src/renderer/lib/store-resources', () => ({
  categoryTaxonomyResource: { invalidate: vi.fn(), get: vi.fn() },
  discoverPageResource: { invalidate: vi.fn(), get: vi.fn() },
}))

vi.mock('../../../src/renderer/stores/apps.store', () => ({
  useAppsStore: { getState: () => ({ apps: [] }) },
}))

const persisted = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => persisted.get(key) ?? null,
  setItem: (key: string, value: string) => { persisted.set(key, value) },
  removeItem: (key: string) => { persisted.delete(key) },
})

const { useAppsPageStore } = await import('../../../src/renderer/stores/apps-page.store')

function detailOf(slug: string) {
  return { success: true, data: { entry: { slug, type: 'skill' }, registryId: 'halo' } }
}

function viewedSlugs(): string[] {
  return trackEvent.mock.calls
    .filter(([event]) => event === 'store.detail.view')
    .map(([, props]) => (props as { appId: string }).appId)
}

describe('store detail view telemetry', () => {
  beforeEach(() => {
    trackEvent.mockClear()
    storeGetAppDetail.mockReset()
    useAppsPageStore.getState().clearStoreSelection()
    trackEvent.mockClear()
  })

  it('counts the load a retry succeeds at, having counted nothing for the failure', async () => {
    storeGetAppDetail
      .mockResolvedValueOnce({ success: false, error: 'offline' })
      .mockResolvedValueOnce(detailOf('alpha'))

    await useAppsPageStore.getState().selectStoreApp('alpha')
    expect(viewedSlugs()).toEqual([])

    await useAppsPageStore.getState().selectStoreApp('alpha')
    expect(viewedSlugs()).toEqual(['alpha'])
  })

  it('counts one view when an already-loaded detail is re-read', async () => {
    storeGetAppDetail.mockResolvedValue(detailOf('alpha'))

    await useAppsPageStore.getState().selectStoreApp('alpha')
    await useAppsPageStore.getState().selectStoreApp('alpha')

    expect(viewedSlugs()).toEqual(['alpha'])
  })

  it('counts again when the app is reopened after leaving the detail', async () => {
    storeGetAppDetail.mockResolvedValue(detailOf('alpha'))

    await useAppsPageStore.getState().selectStoreApp('alpha')
    useAppsPageStore.getState().clearStoreSelection()
    await useAppsPageStore.getState().selectStoreApp('alpha')

    expect(viewedSlugs()).toEqual(['alpha', 'alpha'])
  })

  it('drops a response that arrives after the user left the detail', async () => {
    let release: (value: unknown) => void = () => {}
    storeGetAppDetail.mockReturnValueOnce(new Promise(resolve => { release = resolve }))

    const pending = useAppsPageStore.getState().selectStoreApp('alpha')
    useAppsPageStore.getState().clearStoreSelection()
    release(detailOf('alpha'))
    await pending

    expect(viewedSlugs()).toEqual([])
    expect(useAppsPageStore.getState().storeSelectedDetail).toBeNull()
  })
})
