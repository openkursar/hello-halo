/**
 * Category contract for the two MCP proxy sources.
 *
 * Neither registry exposes a category, so both label every server `dev-tools`.
 * Ignoring the filter therefore meant any other chip answered with the full
 * unfiltered catalog, rendered under a chip that named a different category.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

// Stub proxy-fetch so fetchWithTimeout falls through to the global fetch mock
// without touching electron.session (not available in Node test environment).
vi.mock('../../../src/main/services/proxy-fetch', () => ({
  proxyFetch: (url: string, init?: RequestInit) => fetch(url, init),
}))

import { McpRegistryAdapter } from '../../../src/main/store/adapters/mcp-registry.adapter'
import { SmitheryAdapter } from '../../../src/main/store/adapters/smithery.adapter'
import type { RegistryAdapter, AdapterQueryResult } from '../../../src/main/store/adapters/types'
import type { RegistrySource, StoreQueryParams } from '../../../src/shared/store/store-types'

const MCP_SOURCE: RegistrySource = {
  id: 'mcp-official',
  name: 'MCP Registry',
  url: 'https://registry.modelcontextprotocol.io',
  enabled: true,
  sourceType: 'mcp-registry',
}

const SMITHERY_SOURCE: RegistrySource = {
  id: 'smithery',
  name: 'Smithery',
  url: 'https://registry.smithery.ai',
  enabled: true,
  sourceType: 'smithery',
}

const MCP_PAYLOAD = {
  servers: [{ server: { name: 'io.github.acme/files', description: 'File tools', version: '1.0.0' } }],
  metadata: { count: 1 },
}

const SMITHERY_PAYLOAD = {
  servers: [{ qualifiedName: 'acme/files', displayName: 'Files', description: 'File tools' }],
  pagination: { currentPage: 1, pageSize: 50, totalPages: 1, totalCount: 1 },
}

const CASES: Array<{
  label: string
  source: RegistrySource
  build: () => RegistryAdapter
  payload: unknown
}> = [
  { label: 'McpRegistryAdapter', source: MCP_SOURCE, build: () => new McpRegistryAdapter(), payload: MCP_PAYLOAD },
  { label: 'SmitheryAdapter', source: SMITHERY_SOURCE, build: () => new SmitheryAdapter(), payload: SMITHERY_PAYLOAD },
]

describe.each(CASES)('$label category contract', ({ source, build, payload }) => {
  let adapter: RegistryAdapter
  let fetchMock: ReturnType<typeof vi.fn>

  function query(params: Partial<StoreQueryParams>): Promise<AdapterQueryResult> {
    return adapter.query!(source, { page: 1, pageSize: 24, type: 'mcp', ...params })
  }

  beforeEach(() => {
    adapter = build()
    fetchMock = vi.fn(() => Promise.resolve(
      new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
    ))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('labels every entry with the one category it serves', async () => {
    const result = await query({})
    expect(result.items).not.toHaveLength(0)
    for (const item of result.items) expect(item.category).toBe('dev-tools')
  })

  it('serves the unfiltered catalog when no category is requested', async () => {
    const result = await query({})
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(result.items).not.toHaveLength(0)
  })

  it('serves its own category', async () => {
    const result = await query({ category: 'dev-tools' })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(result.items).not.toHaveLength(0)
  })

  it.each(['shopping', 'news', 'content', 'productivity', 'data', 'social', 'other'])(
    'answers the "%s" chip empty, without a request',
    async (category) => {
      const result = await query({ category })

      expect(fetchMock).not.toHaveBeenCalled()
      expect(result).toEqual({ items: [], total: 0, hasMore: false })
    },
  )
})
