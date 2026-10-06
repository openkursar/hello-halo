/**
 * Turning a store source off or on changes what the store shows, so the store
 * reads its catalog again instead of painting the list cached from the old
 * set of sources.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const storeQuery = vi.fn()
const invalidateDiscover = vi.fn()

// The listeners below are never exercised; the page store reaches app.store,
// which pulls in modules that subscribe as soon as they are imported.
vi.mock('../../../src/renderer/api', () => ({
  api: {
    storeQuery: (query: unknown) => storeQuery(query),
    trackEvent: vi.fn(),
    onBrowserPageGone: () => () => {}, onBrowserStateChange: () => () => {},
    onArtifactChangedBatch: () => () => {},
    onMemoryPressure: () => () => {},
    getMemoryPressure: async () => 'normal',
  },
}))
vi.mock('../../../src/renderer/i18n', () => ({ getCurrentLanguage: () => 'en' }))
vi.mock('../../../src/renderer/lib/store-resources', () => ({
  categoryTaxonomyResource: { invalidate: vi.fn(), get: vi.fn() },
  discoverPageResource: { invalidate: invalidateDiscover, get: vi.fn() },
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

/** The catalog as the main process would answer it for the given skills. */
function catalog(skills: string[]) {
  storeQuery.mockImplementation(async (query: { type: string }) => ({
    success: true,
    data: { items: query.type === 'skill' ? skills.map(slug => ({ slug, type: 'skill' })) : [], hasMore: false, sources: [] },
  }))
}

const slugs = () => useAppsPageStore.getState().storeApps.map(entry => entry.slug)

describe('store sources changing', () => {
  beforeEach(() => {
    storeQuery.mockReset()
    invalidateDiscover.mockClear()
  })

  it('reads the catalog again instead of keeping what the old sources showed', async () => {
    catalog(['halo-skill', 'community-skill'])
    await useAppsPageStore.getState().loadStoreApps()
    expect(slugs()).toEqual(['halo-skill', 'community-skill'])

    // The community source was turned off.
    catalog(['halo-skill'])
    await useAppsPageStore.getState().reloadStoreCatalog()

    expect(slugs()).toEqual(['halo-skill'])
    expect(invalidateDiscover).toHaveBeenCalled()
  })
})
