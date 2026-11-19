/**
 * Unit tests for the DHP v2 driver.
 *
 * This driver is the store module's single point of contact with HTTP status
 * codes, so the cases here are exactly the protocol decisions the rest of the
 * module no longer makes: absent endpoint vs transient fault, the three-state
 * install-order contract, per-source handshake isolation, and the wire identity
 * vocabulary.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RegistrySource } from '../../../src/shared/store/store-types'

vi.mock('../../../src/main/store/adapters/halo.adapter', async () => {
  const actual = await vi.importActual<typeof import('../../../src/main/store/adapters/halo.adapter')>(
    '../../../src/main/store/adapters/halo.adapter',
  )
  return { ...actual, fetchWithTimeout: vi.fn() }
})

const { fetchWithTimeout, HaloAdapter } = await import('../../../src/main/store/adapters/halo.adapter')
const { DhpV2Adapter } = await import('../../../src/main/store/adapters/dhp-v2.adapter')
const { STORE_NOT_SIGNED_IN } = await import('../../../src/shared/store/store-types')

const fetchMock = vi.mocked(fetchWithTimeout)

function source(id: string, url: string): RegistrySource {
  return { id, name: id, url, enabled: true, sourceType: 'dhp-v2' }
}

/** Minimal Response stand-in: only what the driver actually reads. */
function reply(status: number, body?: unknown, headers?: Record<string, string>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: new Headers(headers),
  } as Response
}

const SRC = source('official', 'http://reg.test/')

describe('DhpV2Adapter — handshake', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('normalizes the advertised features and caches them for the full TTL', async () => {
    const adapter = new DhpV2Adapter()
    fetchMock.mockResolvedValue(
      reply(200, {
        protocol: 'dhp-v2',
        features: {
          installs: true,
          featured: true,
          collections: true,
          reviewWorkflow: true,
          identityBinding: 'account',
          cliTools: { schema: 'halo.cli/1', catalog: '/clis.json' },
        },
      }),
    )

    expect(await adapter.serverFeatures(SRC)).toEqual({
      installs: true,
      featured: true,
      collections: true,
      reviewWorkflow: true,
      identityBinding: 'account',
      cliTools: true,
    })

    vi.advanceTimersByTime(59 * 60 * 1000)
    await adapter.serverFeatures(SRC)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2 * 60 * 1000)
    await adapter.serverFeatures(SRC)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('downgrades an unrecognized identity binding rather than passing it through', async () => {
    const adapter = new DhpV2Adapter()
    fetchMock.mockResolvedValue(reply(200, { features: { identityBinding: 'something-new' } }))

    expect((await adapter.serverFeatures(SRC))?.identityBinding).toBe('none')
  })

  it('treats an absent endpoint as the read-only baseline for the full TTL', async () => {
    const adapter = new DhpV2Adapter()
    fetchMock.mockResolvedValue(reply(404))

    expect(await adapter.serverFeatures(SRC)).toBeNull()
    vi.advanceTimersByTime(10 * 60 * 1000)
    await adapter.serverFeatures(SRC)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the last-known features on a transient fault and retries soon', async () => {
    const adapter = new DhpV2Adapter()
    fetchMock.mockResolvedValueOnce(reply(200, { features: { installs: true, identityBinding: 'account' } }))
    expect((await adapter.serverFeatures(SRC))?.installs).toBe(true)

    vi.advanceTimersByTime(61 * 60 * 1000)
    fetchMock.mockResolvedValueOnce(reply(503))
    // The blip must not strip the backend-gated surfaces.
    expect((await adapter.serverFeatures(SRC))?.installs).toBe(true)

    // …and must not lock the stale value in for a full hour either.
    vi.advanceTimersByTime(6 * 60 * 1000)
    fetchMock.mockResolvedValueOnce(reply(200, { features: { installs: false, identityBinding: 'none' } }))
    expect((await adapter.serverFeatures(SRC))?.installs).toBe(false)
  })

  it('keeps one cache slot per source so a federation cannot cross-talk', async () => {
    const adapter = new DhpV2Adapter()
    const a = source('a', 'http://a.test')
    const b = source('b', 'http://b.test')
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith('http://a.test')
        ? reply(200, { features: { installs: true } })
        : reply(200, { features: { installs: false } }),
    )

    expect((await adapter.serverFeatures(a))?.installs).toBe(true)
    expect((await adapter.serverFeatures(b))?.installs).toBe(false)
    expect((await adapter.serverFeatures(a))?.installs).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('DhpV2Adapter — install orders', () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })

  const order = {
    slug: 'alice/hn-daily',
    version: '1.2.0',
    installId: 'device-1',
    orderUuid: 'intent-1',
  }

  it('grants the server-decided bundle path and escapes both slug segments', async () => {
    const adapter = new DhpV2Adapter()
    fetchMock.mockResolvedValue(reply(200, { orderId: 7, path: 'apps/alice/hn-daily/1.2.0' }))

    expect(await adapter.openInstallOrder(SRC, order, { token: 'tok' })).toEqual({
      path: 'apps/alice/hn-daily/1.2.0',
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://reg.test/apps/alice/hn-daily/installs')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' })
  })

  it('carries the intent uuid the server counts by', async () => {
    const adapter = new DhpV2Adapter()
    fetchMock.mockResolvedValue(reply(200, { path: 'apps/x/1.0' }))

    await adapter.openInstallOrder(SRC, order)
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      installId: 'device-1',
      version: '1.2.0',
      orderUuid: 'intent-1',
    })
  })

  it('omits the Authorization header for an anonymous install', async () => {
    const adapter = new DhpV2Adapter()
    fetchMock.mockResolvedValue(reply(200, { path: 'apps/x/1.0' }))

    await adapter.openInstallOrder(SRC, order)
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).not.toHaveProperty('Authorization')
  })

  it('returns null on a permanent refusal so the caller does not queue a backfill', async () => {
    const adapter = new DhpV2Adapter()
    fetchMock.mockResolvedValue(reply(404))

    await expect(adapter.openInstallOrder(SRC, order)).resolves.toBeNull()
  })

  it('throws on a retryable fault so the caller queues a backfill', async () => {
    const adapter = new DhpV2Adapter()
    fetchMock.mockResolvedValue(reply(503))

    await expect(adapter.openInstallOrder(SRC, order)).rejects.toThrow('install order failed: 503')
  })
})

describe('DhpV2Adapter — collections and page documents', () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('distinguishes an empty collection list from a backend failure', async () => {
    const adapter = new DhpV2Adapter()

    fetchMock.mockResolvedValueOnce(reply(200, { collections: [] }))
    await expect(adapter.fetchCollections(SRC)).resolves.toEqual([])

    fetchMock.mockResolvedValueOnce(reply(500))
    await expect(adapter.fetchCollections(SRC)).rejects.toThrow('collections failed: 500')
  })

  it('separates an absent page document from a fault', async () => {
    const adapter = new DhpV2Adapter()

    fetchMock.mockResolvedValueOnce(reply(404))
    await expect(adapter.fetchPageTaxonomy(SRC)).resolves.toEqual({ status: 'absent' })

    fetchMock.mockResolvedValueOnce(reply(200, { default: [{ id: 'news' }] }, { ETag: '"v1"' }))
    await expect(adapter.fetchPageLayout(SRC)).resolves.toEqual({
      status: 'ok',
      document: { default: [{ id: 'news' }] },
      validator: '"v1"',
    })

    fetchMock.mockResolvedValueOnce(reply(502))
    await expect(adapter.fetchPageLayout(SRC)).rejects.toThrow('HTTP 502')
  })

  it('revalidates a page document with its validator and reports it unchanged', async () => {
    const adapter = new DhpV2Adapter()

    fetchMock.mockResolvedValueOnce(reply(304))
    await expect(adapter.fetchPageLayout(SRC, '"v1"')).resolves.toEqual({ status: 'unchanged' })

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['If-None-Match']).toBe('"v1"')
  })
})

/**
 * This driver delegates its catalog to Halo, and a delegation that quietly drops
 * an argument still compiles, still runs, and still returns a usable index — it
 * just never revalidates. Since the enterprise build ships this source type,
 * that failure would cost a full index download on every freshness check.
 */
describe('DhpV2Adapter — catalog delegation', () => {
  it('forwards index validators to the delegated catalog driver', async () => {
    const delegate = vi
      .spyOn(HaloAdapter.prototype, 'fetchIndex')
      .mockResolvedValue({ index: null, validators: {} })

    await new DhpV2Adapter().fetchIndex(SRC, { 'skills.json': '"v1"' })

    expect(delegate).toHaveBeenCalledWith(SRC, { 'skills.json': '"v1"' })
    delegate.mockRestore()
  })
})

describe('DhpV2Adapter — creator publications', () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('surfaces a rejected token as the shared signed-out sentinel', async () => {
    const adapter = new DhpV2Adapter()
    fetchMock.mockResolvedValue(reply(401))

    await expect(adapter.fetchMyPublications(SRC, { token: 'stale' })).rejects.toThrow(STORE_NOT_SIGNED_IN)
    await expect(adapter.unpublish(SRC, 'alice/app', { token: 'stale' })).rejects.toThrow(STORE_NOT_SIGNED_IN)
  })

  it('reports an ownership refusal distinctly from a sign-in problem', async () => {
    const adapter = new DhpV2Adapter()
    fetchMock.mockResolvedValue(reply(403))

    await expect(adapter.unpublish(SRC, 'bob/app', { token: 'tok' })).rejects.toThrow(
      'You can only unpublish your own apps',
    )
  })

  it('posts the action against the scoped slug', async () => {
    const adapter = new DhpV2Adapter()
    fetchMock.mockResolvedValue(reply(200, {}))

    await adapter.unpublish(SRC, 'alice/hn-daily', { token: 'tok' })
    expect(fetchMock.mock.calls[0][0]).toBe('http://reg.test/my/publications/alice/hn-daily/unpublish')
  })
})

/** A download Response stand-in carrying bytes. */
function binary(status: number, bytes: Uint8Array, headers?: Record<string, string>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    body: { cancel: async () => undefined },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response
}

describe('DhpV2Adapter — CLI tool catalog', () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('does not advertise the catalog unless the handshake carries a cliTools block', async () => {
    const adapter = new DhpV2Adapter()
    fetchMock.mockResolvedValue(reply(200, { features: { cliTools: true } }))
    expect((await adapter.serverFeatures(source('a', 'http://a.test')))?.cliTools).toBe(false)
  })

  it('reads the catalog with the account token and treats absence as no catalog', async () => {
    const adapter = new DhpV2Adapter()
    fetchMock.mockResolvedValueOnce(reply(200, { schema: 'halo.cli.catalog/1', tools: [] }))
    expect(await adapter.fetchCliCatalog(SRC, { token: 'tok' })).toEqual({ schema: 'halo.cli.catalog/1', tools: [] })
    expect(fetchMock.mock.calls[0][0]).toBe('http://reg.test/clis.json')
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer tok')

    fetchMock.mockResolvedValueOnce(reply(404))
    expect(await adapter.fetchCliCatalog(SRC, { token: 'tok' })).toBeNull()
  })

  it('surfaces a rejected token as the signed-out sentinel and other faults as errors', async () => {
    const adapter = new DhpV2Adapter()
    fetchMock.mockResolvedValueOnce(reply(401))
    await expect(adapter.fetchCliCatalog(SRC, { token: 'stale' })).rejects.toThrow(STORE_NOT_SIGNED_IN)
    fetchMock.mockResolvedValueOnce(reply(503))
    await expect(adapter.fetchCliCatalog(SRC, { token: 'tok' })).rejects.toThrow('cli-catalog failed: 503')
  })

  it('downloads a package path on the same source, keeping a gateway prefix', async () => {
    const adapter = new DhpV2Adapter()
    const gateway = source('gw', 'https://gw.test/store/')
    fetchMock.mockResolvedValueOnce(binary(200, new Uint8Array([1, 2, 3]), { 'Content-Length': '3' }))
    const bytes = await adapter.downloadCliPackage(gateway, '/clis/com.example.tool/1.0.0/package.hcli', { token: 'tok' }, 10)
    expect(Array.from(bytes)).toEqual([1, 2, 3])
    expect(fetchMock.mock.calls[0][0]).toBe('https://gw.test/store/clis/com.example.tool/1.0.0/package.hcli')
  })

  it('refuses a catalog path that could send the token elsewhere', async () => {
    const adapter = new DhpV2Adapter()
    for (const bad of [
      'https://evil.test/x.hcli',
      '//evil.test/x.hcli',
      'clis/a/1.0.0/package.hcli',
      '/clis/../admin',
      '/clis/%2e%2e/admin',
      '/clis\\a',
      '/clis/a?x=1',
    ]) {
      await expect(adapter.downloadCliPackage(SRC, bad, { token: 'tok' }, 10)).rejects.toThrow('not a plain path')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a body larger than the limit, declared or actual', async () => {
    const adapter = new DhpV2Adapter()
    fetchMock.mockResolvedValueOnce(binary(200, new Uint8Array(4), { 'Content-Length': '400' }))
    await expect(adapter.downloadCliPackage(SRC, '/clis/a/1.0.0/package.hcli', { token: 'tok' }, 10)).rejects.toThrow('larger than allowed')
    fetchMock.mockResolvedValueOnce(binary(200, new Uint8Array(11)))
    await expect(adapter.downloadCliPackage(SRC, '/clis/a/1.0.0/package.hcli', { token: 'tok' }, 10)).rejects.toThrow('larger than allowed')
  })

  it('reports a withdrawn package and a rejected token distinctly', async () => {
    const adapter = new DhpV2Adapter()
    fetchMock.mockResolvedValueOnce(binary(404, new Uint8Array()))
    await expect(adapter.downloadCliPackage(SRC, '/clis/a/1.0.0/package.hcli', { token: 'tok' }, 10)).rejects.toThrow('no longer available')
    fetchMock.mockResolvedValueOnce(binary(401, new Uint8Array()))
    await expect(adapter.downloadCliPackage(SRC, '/clis/a/1.0.0/package.hcli', { token: 'tok' }, 10)).rejects.toThrow(STORE_NOT_SIGNED_IN)
  })
})
