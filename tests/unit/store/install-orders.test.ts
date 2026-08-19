/**
 * Unit tests for the install ledger.
 *
 * This module owns ledger policy, not protocol: the cases below are the
 * decisions it actually makes — what identifies one install, never failing an
 * install because the server is unreachable, keeping the retry queue
 * per-source, bounded and corruption-tolerant, and replaying it exactly once at
 * startup.
 *
 * The intent cases are the load-bearing ones. The upgrade scheduler retries a
 * failed download every tick forever, so an intent that re-minted its uuid per
 * attempt would bill one install per tick per device off a single bad release.
 *
 * The filesystem is real (a temp HOME) so the on-disk contract is exercised
 * rather than mocked; the driver and identity below the module are stubbed.
 * Nothing from registry.service is stubbed because nothing is imported from it
 * — sources arrive as arguments, which is what keeps the two out of a cycle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { RegistrySource, InstallGrant } from '../../../src/shared/store/store-types'

let haloDir = ''

vi.mock('../../../src/main/foundation/config.service', () => ({ getHaloDir: () => haloDir }))
vi.mock('../../../src/main/store/adapters', () => ({ getAdapter: vi.fn() }))
vi.mock('../../../src/main/store/backend/identity', () => ({ getStoreIdentityToken: vi.fn(async () => null) }))

const adapters = await import('../../../src/main/store/adapters')
const identity = await import('../../../src/main/store/backend/identity')
const { authorizeInstall, completeInstallIntent, flushPendingInstallOrders } = await import(
  '../../../src/main/store/backend/install-orders'
)

const getAdapter = vi.mocked(adapters.getAdapter)
const getStoreIdentityToken = vi.mocked(identity.getStoreIdentityToken)

const PENDING = 'store-install-orders.pending.json'
const GRANT: InstallGrant = { path: 'apps/alpha/1.0.0' }

type QueuedOrder = { slug: string; version: string; orderUuid?: string; registryId?: string }
type SentOrder = { slug: string; version: string; installId: string; orderUuid: string }

function source(id: string): RegistrySource {
  return { id, name: id, url: `http://${id}.test/`, enabled: true, sourceType: 'dhp-v2' }
}

/** Install a driver whose `openInstallOrder` behaves as given. */
function driver(openInstallOrder?: unknown): void {
  getAdapter.mockReturnValue({ openInstallOrder } as never)
}

/** Source resolution as the bootstrap supplies it, resolving every known id. */
function lookup(overrides?: Partial<{ byId: (id: string) => RegistrySource | null; primary: () => RegistrySource | null }>) {
  return {
    byId: overrides?.byId ?? ((id: string) => source(id)),
    primary: overrides?.primary ?? (() => null),
  }
}

function pendingPath(): string {
  return join(haloDir, PENDING)
}

function readQueue(): QueuedOrder[] {
  return existsSync(pendingPath()) ? JSON.parse(readFileSync(pendingPath(), 'utf-8')) : []
}

function seedQueue(orders: QueuedOrder[]): void {
  writeFileSync(pendingPath(), JSON.stringify(orders))
}

function sent(open: { mock: { calls: unknown[][] } }): SentOrder[] {
  return open.mock.calls.map(c => c[1] as SentOrder)
}

beforeEach(() => {
  haloDir = mkdtempSync(join(tmpdir(), 'halo-orders-'))
  vi.clearAllMocks()
  getStoreIdentityToken.mockResolvedValue(null)
})

afterEach(() => {
  rmSync(haloDir, { recursive: true, force: true })
})

describe('authorizeInstall', () => {
  it('returns the grant and queues nothing when the source authorises', async () => {
    const open = vi.fn(async () => GRANT)
    driver(open)

    expect(await authorizeInstall(source('official'), { slug: 'alpha', version: '1.0.0' })).toBe(GRANT)
    expect(readQueue()).toEqual([])
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'official' }),
      expect.objectContaining({ slug: 'alpha', version: '1.0.0', orderUuid: expect.any(String) }),
      undefined,
    )
  })

  it('issues no request and writes no intent when the source has no ledger', async () => {
    driver(undefined)

    expect(await authorizeInstall(source('community'), { slug: 'alpha', version: '1.0.0' })).toBeNull()
    expect(readQueue()).toEqual([])
    expect(existsSync(join(haloDir, 'store-install-intents.json'))).toBe(false)
  })

  it('queues for retry and still lets the install proceed when the source is unreachable', async () => {
    driver(vi.fn(async () => { throw new Error('ECONNREFUSED') }))

    expect(await authorizeInstall(source('official'), { slug: 'alpha', version: '1.0.0' })).toBeNull()
    expect(readQueue()).toEqual([
      { slug: 'alpha', version: '1.0.0', orderUuid: expect.any(String), registryId: 'official' },
    ])
  })

  it('passes the identity token when signed in', async () => {
    getStoreIdentityToken.mockResolvedValue('tok')
    const open = vi.fn(async () => GRANT)
    driver(open)

    await authorizeInstall(source('official'), { slug: 'alpha', version: '1.0.0' })
    expect(open).toHaveBeenCalledWith(expect.anything(), expect.anything(), { token: 'tok' })
  })

  it('stays anonymous when identity resolution fails', async () => {
    getStoreIdentityToken.mockRejectedValue(new Error('no session'))
    const open = vi.fn(async () => GRANT)
    driver(open)

    await authorizeInstall(source('official'), { slug: 'alpha', version: '1.0.0' })
    expect(open).toHaveBeenCalledWith(expect.anything(), expect.anything(), undefined)
  })

  it('reuses one install id across orders', async () => {
    const open = vi.fn(async () => GRANT)
    driver(open)

    await authorizeInstall(source('official'), { slug: 'alpha', version: '1.0.0' })
    await authorizeInstall(source('official'), { slug: 'beta', version: '1.0.0' })
    const [first, second] = sent(open).map(o => o.installId)
    expect(first).toBeTruthy()
    expect(second).toBe(first)
  })

  it('does nothing for an entry carrying no version', async () => {
    const open = vi.fn(async () => GRANT)
    driver(open)

    expect(await authorizeInstall(source('official'), { slug: 'ghost', version: '' })).toBeNull()
    expect(open).not.toHaveBeenCalled()
    expect(readQueue()).toEqual([])
  })
})

describe('install intent', () => {
  it('reuses one uuid across retries of the same target', async () => {
    const open = vi.fn(async () => GRANT)
    driver(open)

    // What the upgrade scheduler does every tick while a release is broken.
    for (let i = 0; i < 3; i++) {
      await authorizeInstall(source('official'), { slug: 'alpha', version: '2.0.0' })
    }

    const uuids = sent(open).map(o => o.orderUuid)
    expect(uuids[0]).toBeTruthy()
    expect(new Set(uuids).size).toBe(1)
  })

  it('mints a new uuid once the download has landed', async () => {
    const open = vi.fn(async () => GRANT)
    driver(open)
    const target = { slug: 'alpha', version: '1.0.0' }

    await authorizeInstall(source('official'), target)
    completeInstallIntent(source('official'), target)
    await authorizeInstall(source('official'), target)

    const [first, second] = sent(open).map(o => o.orderUuid)
    expect(second).not.toBe(first)
  })

  it('mints a new uuid when the target version changes, and voids the old intent', async () => {
    const open = vi.fn(async () => GRANT)
    driver(open)

    await authorizeInstall(source('official'), { slug: 'alpha', version: '1.0.0' })
    await authorizeInstall(source('official'), { slug: 'alpha', version: '1.1.0' })
    await authorizeInstall(source('official'), { slug: 'alpha', version: '1.0.0' })

    const [v1, v11, v1again] = sent(open).map(o => o.orderUuid)
    expect(v11).not.toBe(v1)
    expect(v1again).not.toBe(v1)
  })

  it('keeps intents separate per source so a federated app is not conflated', async () => {
    const open = vi.fn(async () => GRANT)
    driver(open)

    await authorizeInstall(source('official'), { slug: 'alpha', version: '1.0.0' })
    await authorizeInstall(source('mirror'), { slug: 'alpha', version: '1.0.0' })

    const [a, b] = sent(open).map(o => o.orderUuid)
    expect(b).not.toBe(a)
  })

  it('survives a corrupted intent file rather than throwing', async () => {
    writeFileSync(join(haloDir, 'store-install-intents.json'), '{ not json')
    const open = vi.fn(async () => GRANT)
    driver(open)

    await authorizeInstall(source('official'), { slug: 'alpha', version: '1.0.0' })
    expect(sent(open)[0].orderUuid).toBeTruthy()
  })
})

describe('retry queue', () => {
  it('keeps one entry per intent for the same slug and version', async () => {
    driver(vi.fn(async () => { throw new Error('offline') }))

    await authorizeInstall(source('official'), { slug: 'alpha', version: '1.0.0' })
    await authorizeInstall(source('official'), { slug: 'alpha', version: '1.0.0' })
    await authorizeInstall(source('mirror'), { slug: 'alpha', version: '1.0.0' })

    expect(readQueue().map(o => o.registryId)).toEqual(['official', 'mirror'])
  })

  it('caps the queue at 200 entries, keeping the newest', async () => {
    seedQueue(Array.from({ length: 250 }, (_, i) => ({ slug: `a${i}`, version: '1.0.0', registryId: 'official' })))
    driver(vi.fn(async () => { throw new Error('offline') }))

    await authorizeInstall(source('official'), { slug: 'fresh', version: '1.0.0' })

    const queue = readQueue()
    expect(queue).toHaveLength(200)
    expect(queue[queue.length - 1]).toMatchObject({ slug: 'fresh', registryId: 'official' })
  })

  it('starts clean from a corrupted queue file rather than throwing', async () => {
    writeFileSync(pendingPath(), '{ not json')
    driver(vi.fn(async () => { throw new Error('offline') }))

    await authorizeInstall(source('official'), { slug: 'alpha', version: '1.0.0' })
    expect(readQueue()).toEqual([
      { slug: 'alpha', version: '1.0.0', orderUuid: expect.any(String), registryId: 'official' },
    ])
  })
})

describe('flushPendingInstallOrders', () => {
  it('does nothing without a queue file', async () => {
    driver(vi.fn())
    await flushPendingInstallOrders(lookup())
    expect(getAdapter).not.toHaveBeenCalled()
  })

  it('replays each order against its own source and clears the file', async () => {
    seedQueue([
      { slug: 'alpha', version: '1.0.0', orderUuid: 'uuid-a', registryId: 'official' },
      { slug: 'beta', version: '2.0.0', orderUuid: 'uuid-b', registryId: 'mirror' },
    ])
    const open = vi.fn(async () => GRANT)
    driver(open)

    await flushPendingInstallOrders(lookup())

    expect(open.mock.calls.map(c => [(c[0] as RegistrySource).id, c[1] as SentOrder])).toEqual([
      ['official', expect.objectContaining({ slug: 'alpha', orderUuid: 'uuid-a' })],
      ['mirror', expect.objectContaining({ slug: 'beta', orderUuid: 'uuid-b' })],
    ])
    expect(existsSync(pendingPath())).toBe(false)
  })

  it('resolves a legacy entry without registryId against the primary source', async () => {
    seedQueue([{ slug: 'alpha', version: '1.0.0' }])
    const primary = vi.fn(() => source('official'))
    const open = vi.fn(async () => GRANT)
    driver(open)

    await flushPendingInstallOrders(lookup({ primary }))

    expect(primary).toHaveBeenCalled()
    expect((open.mock.calls[0][0] as RegistrySource).id).toBe('official')
  })

  it('replays a legacy entry with no uuid so the server falls back to its own key', async () => {
    seedQueue([{ slug: 'alpha', version: '1.0.0', registryId: 'official' }])
    const open = vi.fn(async () => GRANT)
    driver(open)

    await flushPendingInstallOrders(lookup())

    expect(sent(open)[0].orderUuid).toBe('')
  })

  it('requeues only the orders that failed again', async () => {
    seedQueue([
      { slug: 'alpha', version: '1.0.0', orderUuid: 'uuid-a', registryId: 'official' },
      { slug: 'beta', version: '2.0.0', orderUuid: 'uuid-b', registryId: 'official' },
    ])
    driver(vi.fn(async (_s: RegistrySource, order: { slug: string }) => {
      if (order.slug === 'beta') throw new Error('still offline')
      return GRANT
    }))

    await flushPendingInstallOrders(lookup())

    expect(readQueue()).toEqual([
      { slug: 'beta', version: '2.0.0', orderUuid: 'uuid-b', registryId: 'official' },
    ])
  })

  it('keeps an order enqueued while the replay was in flight', async () => {
    // Bootstrap starts the upgrade scheduler alongside the replay, so an install
    // can fail and queue during it. Writing back the pre-flush snapshot would
    // erase that order — a lost count with no signal.
    seedQueue([{ slug: 'alpha', version: '1.0.0', orderUuid: 'uuid-a', registryId: 'official' }])
    driver(
      vi.fn(async (_s: RegistrySource, order: { slug: string }) => {
        if (order.slug === 'latecomer') throw new Error('offline')
        // Mid-replay, a concurrent install fails and queues itself.
        await authorizeInstall(source('official'), { slug: 'latecomer', version: '3.0.0' })
        return GRANT
      }),
    )

    await flushPendingInstallOrders(lookup())

    expect(readQueue()).toEqual([
      { slug: 'latecomer', version: '3.0.0', orderUuid: expect.any(String), registryId: 'official' },
    ])
  })

  it('drops orders whose source no longer exists', async () => {
    seedQueue([{ slug: 'alpha', version: '1.0.0', registryId: 'deleted' }])
    const open = vi.fn(async () => GRANT)
    driver(open)

    await flushPendingInstallOrders(lookup({ byId: () => null }))

    expect(open).not.toHaveBeenCalled()
    expect(existsSync(pendingPath())).toBe(false)
  })

  it('discards entries that are not well-formed orders', async () => {
    seedQueue([{ slug: 'alpha', version: '1.0.0', registryId: 'official' }, { slug: 'broken' } as never])
    const open = vi.fn(async () => GRANT)
    driver(open)

    await flushPendingInstallOrders(lookup())

    expect(open).toHaveBeenCalledTimes(1)
    expect(existsSync(pendingPath())).toBe(false)
  })
})
