/**
 * The page-document resolver is the only place that decides what `invalidate`
 * costs. Dropping the validator along with the TTL would turn every forced
 * re-read — and the store revalidates on every tab switch — back into a full
 * download, which no build or type check would catch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PageDocumentResult } from '../../../src/main/store/adapters/types'

const fetchPageLayout = vi.fn<(source: unknown, validator?: string) => Promise<PageDocumentResult>>()

vi.mock('../../../src/main/store/registry.service', () => ({
  getPrimaryRegistry: () => ({ id: 'official', url: 'http://reg.test' }),
}))
vi.mock('../../../src/main/store/adapters', () => ({
  getAdapter: () => ({ fetchPageLayout }),
}))

const { createPageDocumentResolver } = await import('../../../src/main/store/backend/sources')

const identity = (raw: unknown) => raw as { v: number }

describe('createPageDocumentResolver', () => {
  beforeEach(() => fetchPageLayout.mockReset())

  it('revalidates with the validator it was given, across an invalidate', async () => {
    fetchPageLayout.mockResolvedValueOnce({ status: 'ok', document: { v: 1 }, validator: '"a"' })
    const resolver = createPageDocumentResolver('test', 'fetchPageLayout', identity)

    expect(await resolver.get()).toEqual({ v: 1 })
    expect(fetchPageLayout.mock.calls[0][1]).toBeUndefined()

    resolver.invalidate()
    fetchPageLayout.mockResolvedValueOnce({ status: 'unchanged' })

    expect(await resolver.get()).toEqual({ v: 1 })
    expect(fetchPageLayout.mock.calls[1][1]).toBe('"a"')
  })

  it('keeps serving the held document when the source reports it unchanged', async () => {
    fetchPageLayout.mockResolvedValueOnce({ status: 'ok', document: { v: 7 }, validator: '"a"' })
    const resolver = createPageDocumentResolver('test', 'fetchPageLayout', identity)
    await resolver.get()

    resolver.invalidate()
    fetchPageLayout.mockResolvedValueOnce({ status: 'unchanged' })
    resolver.invalidate()
    fetchPageLayout.mockResolvedValueOnce({ status: 'unchanged' })

    expect(await resolver.get()).toEqual({ v: 7 })
    expect(await resolver.get()).toEqual({ v: 7 })
  })

  it('falls the caller through when the source serves no such document', async () => {
    fetchPageLayout.mockResolvedValueOnce({ status: 'absent' })
    const resolver = createPageDocumentResolver('test', 'fetchPageLayout', identity)

    expect(await resolver.get()).toBeNull()
  })

  it('holds off re-fetching after a first fetch faults', async () => {
    fetchPageLayout.mockRejectedValueOnce(new Error('registry unreachable'))
    const resolver = createPageDocumentResolver('test', 'fetchPageLayout', identity)

    expect(await resolver.get()).toBeNull()
    expect(await resolver.get()).toBeNull()
    expect(await resolver.get()).toBeNull()

    expect(fetchPageLayout).toHaveBeenCalledTimes(1)
  })

  it('retains the last good document when a re-read faults', async () => {
    fetchPageLayout.mockResolvedValueOnce({ status: 'ok', document: { v: 3 }, validator: '"a"' })
    const resolver = createPageDocumentResolver('test', 'fetchPageLayout', identity)
    await resolver.get()

    resolver.invalidate()
    fetchPageLayout.mockRejectedValueOnce(new Error('network down'))

    expect(await resolver.get()).toEqual({ v: 3 })
  })
})
