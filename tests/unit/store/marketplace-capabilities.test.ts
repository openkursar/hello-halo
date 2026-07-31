/**
 * Unit tests for the marketplace capabilities aggregator.
 *
 * The aggregator projects product-config (publish) + the server /capabilities
 * probe into the renderer-safe capability slice. Dependencies are mocked and the
 * module is re-imported per test so the probe TTL cache never leaks across cases.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/main/store/publish', () => ({ resolvePublishTarget: vi.fn(() => null) }))
vi.mock('../../../src/main/store/registry.service', () => ({ getOfficialRegistryUrl: vi.fn(() => null) }))
vi.mock('../../../src/main/store/adapters/halo.adapter', () => ({ fetchWithTimeout: vi.fn() }))
// A client identity provider must be present for server "um" binding to survive
// the resolveIdentity intersection (server um ∩ client provider → um).
vi.mock('../../../src/main/foundation/product-config', () => ({
  getMarketplaceIdentityProvider: vi.fn(() => 'halo-cloud'),
}))

async function loadModules() {
  const publish = await import('../../../src/main/store/publish')
  const registry = await import('../../../src/main/store/registry.service')
  const adapter = await import('../../../src/main/store/adapters/halo.adapter')
  const caps = await import('../../../src/main/store/marketplace-capabilities')
  return {
    resolvePublishTarget: vi.mocked(publish.resolvePublishTarget),
    getOfficialRegistryUrl: vi.mocked(registry.getOfficialRegistryUrl),
    fetchWithTimeout: vi.mocked(adapter.fetchWithTimeout),
    getMarketplaceCapabilities: caps.getMarketplaceCapabilities,
  }
}

describe('marketplace-capabilities', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('reports the read-only baseline with no publish target and no server', async () => {
    const m = await loadModules()
    m.resolvePublishTarget.mockReturnValue(null)
    m.getOfficialRegistryUrl.mockReturnValue(null)

    expect(await m.getMarketplaceCapabilities()).toEqual({
      catalog: true,
      installs: false,
      publish: false,
      reviewWorkflow: false,
      identity: 'none',
    })
  })

  it('reports publish=true from product config while backend surfaces stay off without a probe', async () => {
    const m = await loadModules()
    m.resolvePublishTarget.mockReturnValue({
      registryId: 'official',
      config: { target: 'http-registry', token: 'secret' },
    } as ReturnType<typeof m.resolvePublishTarget>)
    m.getOfficialRegistryUrl.mockReturnValue(null)

    const caps = await m.getMarketplaceCapabilities()
    expect(caps.publish).toBe(true)
    expect(caps.installs).toBe(false)
    expect(caps.reviewWorkflow).toBe(false)
  })

  it('merges server /capabilities features when the official source advertises them', async () => {
    const m = await loadModules()
    m.resolvePublishTarget.mockReturnValue(null)
    m.getOfficialRegistryUrl.mockReturnValue("http://reg.test")
    m.fetchWithTimeout.mockResolvedValue({
      ok: true,
      json: async () => ({
        protocol: 'dhp-v2',
        features: { installs: true, collections: true, featured: false, reviewWorkflow: true, identityBinding: 'um' },
      }),
    } as Response)

    const caps = await m.getMarketplaceCapabilities()
    expect(caps.installs).toBe(true)
    expect(caps.reviewWorkflow).toBe(true)
    expect(caps.identity).toBe('um')
  })

  it('degrades to the baseline on a 404 (static / OSS source with no endpoint)', async () => {
    const m = await loadModules()
    m.resolvePublishTarget.mockReturnValue(null)
    m.getOfficialRegistryUrl.mockReturnValue("http://reg.test")
    m.fetchWithTimeout.mockResolvedValue({ ok: false, status: 404 } as Response)

    const caps = await m.getMarketplaceCapabilities()
    expect(caps.installs).toBe(false)
    expect(caps.reviewWorkflow).toBe(false)
    expect(caps.identity).toBe('none')
  })

  it('degrades to the baseline on a network error', async () => {
    const m = await loadModules()
    m.resolvePublishTarget.mockReturnValue(null)
    m.getOfficialRegistryUrl.mockReturnValue("http://reg.test")
    m.fetchWithTimeout.mockRejectedValue(new Error('offline'))

    const caps = await m.getMarketplaceCapabilities()
    expect(caps.installs).toBe(false)
    expect(caps.reviewWorkflow).toBe(false)
    expect(caps.identity).toBe('none')
  })
})
