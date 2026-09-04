/**
 * Unit tests for the discover-page aggregator.
 *
 * The aggregator exists so sections are scored against the whole index rather
 * than the browse list's current page, so these cover which index it reads,
 * what it drops, and that the catalog page comes from the shared browse query.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/main/store/backend/discover', () => ({ getDiscoverLayout: vi.fn() }))
vi.mock('../../../src/main/store/backend/collections', () => ({ fetchCollections: vi.fn() }))
vi.mock('../../../src/main/store/registry.service', () => ({ listApps: vi.fn(), queryStore: vi.fn() }))

import type { DiscoverLayout, RegistryEntry } from '../../../src/shared/store/store-types'

function entry(slug: string, type: string, installs?: number): RegistryEntry {
  return {
    slug,
    name: slug,
    description: '',
    author: 'a',
    type,
    version: '1.0.0',
    category: 'dev-tools',
    tags: [],
    ...(installs === undefined ? {} : { meta: { installs } }),
  } as unknown as RegistryEntry
}

async function load(layout: DiscoverLayout, opts?: {
  byType?: Record<string, RegistryEntry[]>
  catalog?: { items: RegistryEntry[]; hasMore: boolean }
  collections?: unknown[]
}) {
  const discover = await import('../../../src/main/store/backend/discover')
  const collections = await import('../../../src/main/store/backend/collections')
  const registry = await import('../../../src/main/store/registry.service')
  const page = await import('../../../src/main/store/discover-page')

  vi.mocked(discover.getDiscoverLayout).mockResolvedValue(layout)
  vi.mocked(collections.fetchCollections).mockResolvedValue((opts?.collections ?? []) as never)
  vi.mocked(registry.listApps).mockImplementation(async (q?: { type?: string }) =>
    (opts?.byType?.[q?.type ?? ''] ?? []) as never)
  vi.mocked(registry.queryStore).mockResolvedValue({
    items: opts?.catalog?.items ?? [],
    hasMore: opts?.catalog?.hasMore ?? false,
    sources: [],
  } as never)

  return { getDiscoverPage: page.getDiscoverPage, listApps: vi.mocked(registry.listApps), queryStore: vi.mocked(registry.queryStore), fetchCollections: vi.mocked(collections.fetchCollections) }
}

describe('discover-page', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('ranks a section over the whole index, not a single browse page', async () => {
    const skills = [
      entry('low', 'skill', 1),
      entry('top', 'skill', 900),
      entry('mid', 'skill', 50),
    ]
    const { getDiscoverPage } = await load(
      { version: 1, nodes: [{ type: 'section', layout: 'rank_board', source: { types: ['skill'], sort: 'installs', limit: 2 } }] },
      { byType: { skill: skills } },
    )

    const result = await getDiscoverPage('en', 30)
    expect(result.nodes[0].entries?.map(e => e.slug)).toEqual(['top', 'mid'])
  })

  it('reads the index per type, never with a typeless query', async () => {
    const { getDiscoverPage, listApps } = await load({ version: 1, nodes: [] })
    await getDiscoverPage('en', 30)

    const types = listApps.mock.calls.map(([q]) => (q as { type?: string } | undefined)?.type)
    expect(types).toEqual(['automation', 'skill', 'mcp'])
    // A typeless read is a capped per-type preview, which would defeat the point.
    expect(types).not.toContain(undefined)
  })

  it('drops hidden nodes and sections that resolve to nothing', async () => {
    const { getDiscoverPage } = await load({
      version: 1,
      nodes: [
        { type: 'section', layout: 'card_grid', title: { default: 'hidden' }, hidden: true },
        { type: 'section', layout: 'card_grid', title: { default: 'empty' }, source: { types: ['mcp'] } },
        { type: 'section', layout: 'card_grid', title: { default: 'kept' }, source: { types: ['skill'] } },
      ],
    }, { byType: { skill: [entry('s1', 'skill')] } })

    const result = await getDiscoverPage('en', 30)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].title).toEqual({ default: 'kept' })
  })

  it('drops a row whose children all resolve to nothing', async () => {
    const { getDiscoverPage } = await load({
      version: 1,
      nodes: [{
        type: 'row',
        columns: 2,
        children: [
          { type: 'section', layout: 'card_grid', source: { types: ['mcp'] } },
          { type: 'section', layout: 'card_grid', source: { types: ['automation'] } },
        ],
      }],
    }, { byType: {} })

    const result = await getDiscoverPage('en', 30)
    expect(result.nodes.some(n => n.type === 'row')).toBe(false)
  })

  it('fills the catalog from the shared browse query', async () => {
    const items = [entry('c1', 'skill'), entry('c2', 'automation')]
    const { getDiscoverPage, queryStore } = await load(
      { version: 1, nodes: [{ type: 'catalog' }] },
      { catalog: { items, hasMore: true } },
    )

    const result = await getDiscoverPage('zh-CN', 30)
    expect(result.nodes[0]).toMatchObject({ type: 'catalog', hasMore: true })
    expect(result.nodes[0].entries?.map(e => e.slug)).toEqual(['c1', 'c2'])
    expect(queryStore).toHaveBeenCalledWith({ page: 1, pageSize: 30, locale: 'zh-CN' })
  })

  it('only fetches collections when the layout asks for them', async () => {
    const without = await load({ version: 1, nodes: [{ type: 'catalog' }] })
    await without.getDiscoverPage('en', 30)
    expect(without.fetchCollections).not.toHaveBeenCalled()

    vi.resetModules()
    vi.clearAllMocks()

    const withSection = await load(
      { version: 1, nodes: [{ type: 'section', layout: 'collections' }] },
      {
        byType: { skill: [entry('c1', 'skill')] },
        collections: [{ id: 'c', label: 'l', name: 'n', description: '', memberSlugs: ['c1'] }],
      },
    )
    const result = await withSection.getDiscoverPage('en', 30)
    expect(withSection.fetchCollections).toHaveBeenCalled()
    expect(result.nodes[0].collections).toHaveLength(1)
  })

  it('resolves every collection member from the index, not from the catalog page', async () => {
    const members = Array.from({ length: 18 }, (_, i) => entry(`m${i}`, 'skill'))
    const { getDiscoverPage } = await load(
      { version: 1, nodes: [{ type: 'section', layout: 'collections' }] },
      {
        byType: { skill: members },
        // The catalog page holds a fraction of them: resolving there would cap
        // the collection at whatever fits.
        catalog: { items: members.slice(0, 6), hasMore: true },
        collections: [{
          id: 'c', label: 'l', name: 'n', description: '',
          memberSlugs: members.map(m => m.slug),
        }],
      },
    )

    const result = await getDiscoverPage('en', 30)

    expect(result.nodes[0].collections?.[0].entries).toHaveLength(18)
  })

  it('drops collection members the index does not carry', async () => {
    const { getDiscoverPage } = await load(
      { version: 1, nodes: [{ type: 'section', layout: 'collections' }] },
      {
        byType: { skill: [entry('kept', 'skill')] },
        collections: [{
          id: 'c', label: 'l', name: 'n', description: '',
          memberSlugs: ['kept', 'unpublished'],
        }],
      },
    )

    const result = await getDiscoverPage('en', 30)

    expect(result.nodes[0].collections?.[0].entries.map(e => e.slug)).toEqual(['kept'])
  })

  it('keeps the page alive when one type\'s index query fails', async () => {
    const discover = await import('../../../src/main/store/backend/discover')
    const registry = await import('../../../src/main/store/registry.service')
    const page = await import('../../../src/main/store/discover-page')
    const collections = await import('../../../src/main/store/backend/collections')

    vi.mocked(discover.getDiscoverLayout).mockResolvedValue({
      version: 1,
      nodes: [
        { type: 'section', layout: 'card_grid', title: { default: 'skills' }, source: { types: ['skill'] } },
        { type: 'section', layout: 'card_grid', title: { default: 'autos' }, source: { types: ['automation'] } },
      ],
    })
    vi.mocked(collections.fetchCollections).mockResolvedValue([] as never)
    vi.mocked(registry.queryStore).mockResolvedValue({ items: [], hasMore: false, sources: [] } as never)
    vi.mocked(registry.listApps).mockImplementation(async (q?: { type?: string }) => {
      if (q?.type === 'automation') throw new Error('index unavailable')
      return [entry('s1', 'skill')] as never
    })

    const result = await page.getDiscoverPage('en', 30)
    // The failing type drops out; the healthy section still renders.
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].title).toEqual({ default: 'skills' })
  })

  it('falls back to a catalog node when nothing resolves', async () => {
    const items = [entry('c1', 'skill')]
    const { getDiscoverPage } = await load(
      { version: 1, nodes: [{ type: 'section', layout: 'card_grid', source: { types: ['mcp'] } }] },
      { byType: {}, catalog: { items, hasMore: false } },
    )

    const result = await getDiscoverPage('en', 30)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]).toMatchObject({ type: 'catalog' })
    expect(result.nodes[0].entries?.map(e => e.slug)).toEqual(['c1'])
  })

  it('drops the collections section when the registry serves none', async () => {
    const { getDiscoverPage } = await load(
      { version: 1, nodes: [{ type: 'section', layout: 'collections' }] },
      { collections: [] },
    )
    const result = await getDiscoverPage('en', 30)
    expect(result.nodes.some(n => n.layout === 'collections')).toBe(false)
  })
})
