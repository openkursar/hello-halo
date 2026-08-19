/**
 * Unit tests for the store capabilities aggregator.
 *
 * The aggregator projects product-config (publish) + the primary source's
 * capability handshake into the renderer-safe capability slice. It is a pure
 * projection now: the handshake itself (network, status codes, TTL) belongs to
 * the driver, so the driver is what gets mocked here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RegistrySource, ServerFeatures } from '../../../src/shared/store/store-types'

vi.mock('../../../src/main/store/publish', () => ({ resolvePublishTarget: vi.fn(() => null) }))
vi.mock('../../../src/main/store/registry.service', () => ({ getPrimaryRegistry: vi.fn(() => null) }))
vi.mock('../../../src/main/store/adapters', () => ({ getAdapter: vi.fn(() => ({})) }))
// A client identity provider must be present for a server 'account' binding to
// survive the resolveIdentity intersection (server account ∩ client provider).
vi.mock('../../../src/main/foundation/product-config', () => ({
  getStoreIdentityProvider: vi.fn(() => 'halo-cloud'),
}))

const PRIMARY: RegistrySource = {
  id: 'official',
  name: 'Primary',
  url: 'http://reg.test',
  enabled: true,
  isDefault: true,
  sourceType: 'dhp-v2',
}

async function loadModules() {
  const publish = await import('../../../src/main/store/publish')
  const registry = await import('../../../src/main/store/registry.service')
  const adapters = await import('../../../src/main/store/adapters')
  const caps = await import('../../../src/main/store/backend/capabilities')
  return {
    resolvePublishTarget: vi.mocked(publish.resolvePublishTarget),
    getPrimaryRegistry: vi.mocked(registry.getPrimaryRegistry),
    getAdapter: vi.mocked(adapters.getAdapter),
    getStoreCapabilities: caps.getStoreCapabilities,
    serverRequiresIdentity: caps.serverRequiresIdentity,
  }
}

/** Point the mocked adapter registry at a driver advertising `features`. */
function withHandshake(m: Awaited<ReturnType<typeof loadModules>>, features: ServerFeatures | null): void {
  m.getPrimaryRegistry.mockReturnValue(PRIMARY)
  m.getAdapter.mockReturnValue({
    strategy: 'mirror',
    fetchSpec: vi.fn(),
    serverFeatures: vi.fn(async () => features),
  })
}

function features(overrides: Partial<ServerFeatures> = {}): ServerFeatures {
  return {
    installs: false,
    featured: false,
    collections: false,
    reviewWorkflow: false,
    identityBinding: 'none',
    ...overrides,
  }
}

describe('store capabilities', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('reports the read-only baseline with no publish target and no primary source', async () => {
    const m = await loadModules()
    m.resolvePublishTarget.mockReturnValue(null)
    m.getPrimaryRegistry.mockReturnValue(null)

    expect(await m.getStoreCapabilities()).toEqual({
      catalog: true,
      installs: false,
      publish: false,
      reviewWorkflow: false,
      identity: 'none',
    })
  })

  it('reports publish=true from product config while backend surfaces stay off without a handshake', async () => {
    const m = await loadModules()
    m.resolvePublishTarget.mockReturnValue({
      registryId: 'official',
      config: { target: 'http-registry', token: 'secret' },
    } as ReturnType<typeof m.resolvePublishTarget>)
    m.getPrimaryRegistry.mockReturnValue(null)

    const caps = await m.getStoreCapabilities()
    expect(caps.publish).toBe(true)
    expect(caps.installs).toBe(false)
    expect(caps.reviewWorkflow).toBe(false)
  })

  it('issues no handshake when the primary source driver has no backend surface', async () => {
    const m = await loadModules()
    m.resolvePublishTarget.mockReturnValue(null)
    m.getPrimaryRegistry.mockReturnValue({ ...PRIMARY, sourceType: 'halo' })
    const catalogOnly = { strategy: 'mirror' as const, fetchSpec: vi.fn() }
    m.getAdapter.mockReturnValue(catalogOnly)

    const caps = await m.getStoreCapabilities()
    expect(caps.installs).toBe(false)
    expect(caps.identity).toBe('none')
  })

  it('merges advertised features from the primary source handshake', async () => {
    const m = await loadModules()
    m.resolvePublishTarget.mockReturnValue(null)
    withHandshake(m, features({ installs: true, collections: true, reviewWorkflow: true, identityBinding: 'account' }))

    const caps = await m.getStoreCapabilities()
    expect(caps.installs).toBe(true)
    expect(caps.reviewWorkflow).toBe(true)
    expect(caps.identity).toBe('account')
  })

  it('maps a shared deployment credential to the weak identity mode', async () => {
    const m = await loadModules()
    m.resolvePublishTarget.mockReturnValue(null)
    withHandshake(m, features({ identityBinding: 'shared' }))

    expect((await m.getStoreCapabilities()).identity).toBe('shared')
    expect(await m.serverRequiresIdentity()).toBe(false)
  })

  it('degrades to the baseline when the driver reports no handshake', async () => {
    const m = await loadModules()
    m.resolvePublishTarget.mockReturnValue(null)
    withHandshake(m, null)

    const caps = await m.getStoreCapabilities()
    expect(caps.installs).toBe(false)
    expect(caps.reviewWorkflow).toBe(false)
    expect(caps.identity).toBe('none')
  })

  it('reports the raw server requirement independently of the client intersection', async () => {
    const m = await loadModules()
    withHandshake(m, features({ identityBinding: 'account' }))

    expect(await m.serverRequiresIdentity()).toBe(true)
  })
})
