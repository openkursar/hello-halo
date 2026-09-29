/**
 * The store controller wraps store functions in a response envelope, and
 * several wrappers carry the same name as the function they wrap. An unaliased
 * import of such a name binds to the wrapper, turning the wrapper into infinite
 * self-recursion — which type-checks as valid, builds cleanly, and only fails at
 * runtime with a stack overflow swallowed by the wrapper's own try/catch.
 *
 * These tests assert delegation actually reaches the store module.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const storeMock = {
  getStoreCapabilities: vi.fn(),
  getStoreIdentity: vi.fn(),
  getStoreSignInStatus: vi.fn(),
  getCategoryTaxonomy: vi.fn(),
  getDiscoverLayout: vi.fn(),
  invalidateServerTaxonomyCache: vi.fn(),
  invalidateDiscoverLayoutCache: vi.fn(),
  fetchMyPublications: vi.fn(),
  fetchCollections: vi.fn(),
  unpublishApp: vi.fn(),
  ensureStoreIdentity: vi.fn(),
  listApps: vi.fn(),
  queryStore: vi.fn(),
  getAppDetail: vi.fn(),
  getAppDocument: vi.fn(),
  installFromStore: vi.fn(),
  unpackDhpkg: vi.fn(),
  refreshIndex: vi.fn(),
  checkUpdates: vi.fn(),
  getRegistries: vi.fn(),
  addRegistry: vi.fn(),
  removeRegistry: vi.fn(),
  toggleRegistry: vi.fn(),
  updateRegistryAdapterConfig: vi.fn(),
}

vi.mock('../../../src/main/store', () => storeMock)
vi.mock('../../../src/main/apps/manager', () => ({ getAppManager: vi.fn(() => ({ getApp: vi.fn() })) }))
vi.mock('../../../src/main/apps/runtime', () => ({ getAppRuntime: vi.fn(() => null) }))
vi.mock('../../../src/main/apps/manager/errors', () => ({
  McpCommandBlockedError: class McpCommandBlockedError extends Error { command = '' },
}))
vi.mock('../../../src/main/services/security-policy', () => ({ MCP_COMMAND_BLOCKED_MESSAGE: 'blocked' }))
vi.mock('../../../src/main/services/analytics', () => ({ trackEvent: vi.fn() }))

const controller = await import('../../../src/main/controllers/store.controller')

describe('store controller delegation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('getStoreCapabilities reaches the store module instead of itself', async () => {
    const capabilities = { catalog: true, installs: true, publish: false, reviewWorkflow: false, identity: 'none' }
    storeMock.getStoreCapabilities.mockResolvedValue(capabilities)

    const res = await controller.getStoreCapabilities()

    expect(storeMock.getStoreCapabilities).toHaveBeenCalledTimes(1)
    expect(res).toEqual({ success: true, data: capabilities })
  })

  it('getStoreSignInStatus reaches the store module instead of itself', async () => {
    storeMock.getStoreSignInStatus.mockResolvedValue('available')

    const res = await controller.getStoreSignInStatus()

    expect(storeMock.getStoreSignInStatus).toHaveBeenCalledTimes(1)
    expect(res).toEqual({ success: true, data: 'available' })
  })

  it('getStoreIdentity reaches the store module instead of itself', async () => {
    storeMock.getStoreIdentity.mockReturnValue({ uid: 'u1', name: 'Alice' })

    const res = await controller.getStoreIdentity()

    expect(storeMock.getStoreIdentity).toHaveBeenCalledTimes(1)
    expect(res).toEqual({ success: true, data: { uid: 'u1', name: 'Alice' } })
  })

  it('reports a store-module failure as an error envelope', async () => {
    storeMock.getStoreCapabilities.mockRejectedValue(new Error('probe exploded'))

    expect(await controller.getStoreCapabilities()).toEqual({ success: false, error: 'probe exploded' })
  })

  it('queryStoreApps fills page defaults and rejects an unknown app type', async () => {
    storeMock.queryStore.mockResolvedValue({ items: [], hasMore: false, sources: [] })

    await controller.queryStoreApps({ search: 'x' })
    expect(storeMock.queryStore).toHaveBeenCalledWith(expect.objectContaining({ search: 'x', page: 1 }))
    expect(typeof storeMock.queryStore.mock.calls[0][0].pageSize).toBe('number')

    storeMock.queryStore.mockClear()
    const res = await controller.queryStoreApps({ type: 'bogus' as never })
    expect(res.success).toBe(false)
    expect(storeMock.queryStore).not.toHaveBeenCalled()
  })

  it('listStoreApps rejects an unknown app type instead of dropping it', async () => {
    const res = await controller.listStoreApps({ type: 'bogus' })
    expect(res.success).toBe(false)
    expect(storeMock.listApps).not.toHaveBeenCalled()
  })

  it('queryStoreApps replaces out-of-range paging with defaults', async () => {
    storeMock.queryStore.mockResolvedValue({ items: [], hasMore: false, sources: [] })
    await controller.queryStoreApps({ page: 0, pageSize: -5 })
    expect(storeMock.queryStore).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }))
    expect(storeMock.queryStore.mock.calls[0][0].pageSize).toBeGreaterThan(0)
  })
})
