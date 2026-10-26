import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('../../../src/main/services/proxy-fetch', () => ({ proxyFetch: mocks.fetch }))
import { clearReleaseCache, getNativePlatform, lookupRelease } from '../../../src/main/services/cc-runtime/releases'

const source = { id: 'test', name: 'Test', baseUrl: 'https://mirror.example.test/releases' }
const checksum = 'a'.repeat(64)
const manifest = () => ({ version: '2.1.310', platforms: { [getNativePlatform()]: { checksum, size: 1234 } } })

beforeEach(() => { clearReleaseCache(); mocks.fetch.mockReset() })

describe('CC release metadata lookup', () => {
  it('fetches metadata only and reuses results only for the same source URL', async () => {
    mocks.fetch.mockImplementation(async () => new Response(JSON.stringify(manifest())))
    expect(await lookupRelease(source, '2.1.310')).toMatchObject({ version: '2.1.310', checksum, size: 1234 })
    await lookupRelease(source, '2.1.310')
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    await lookupRelease({ ...source, baseUrl: 'https://other.example.test/releases' }, '2.1.310')
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect(mocks.fetch.mock.calls.every(call => call[0].endsWith('/manifest.json'))).toBe(true)
  })

  it('resolves a channel to one exact manifest version', async () => {
    mocks.fetch.mockImplementation(async (url: string) => new Response(url.endsWith('/latest') ? '2.1.310' : JSON.stringify(manifest())))
    expect(await lookupRelease(source, 'latest')).toMatchObject({ requestedVersion: 'latest', version: '2.1.310' })
    expect(mocks.fetch.mock.calls.map(call => call[0])).toEqual([
      `${source.baseUrl}/latest`, `${source.baseUrl}/2.1.310/manifest.json`
    ])
  })

  it('rejects syntax errors before networking', async () => {
    await expect(lookupRelease(source, 'invalid')).rejects.toMatchObject({ code: 'invalid-version' })
    await expect(lookupRelease(source, '')).rejects.toMatchObject({ code: 'invalid-version' })
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it.each([[404, 'version-not-found'], [401, 'source-unauthorized'], [403, 'source-unauthorized'], [407, 'source-unauthorized'], [408, 'source-timeout'], [504, 'source-timeout'], [503, 'source-unreachable']])('classifies HTTP %s as %s', async (status, code) => {
    mocks.fetch.mockResolvedValue(new Response(null, { status: Number(status) }))
    await expect(lookupRelease(source, '2.1.310')).rejects.toMatchObject({ code })
  })

  it('distinguishes an unreachable source, bad metadata and an absent platform', async () => {
    mocks.fetch.mockRejectedValueOnce(new TypeError('network unreachable'))
    await expect(lookupRelease(source, '2.1.310')).rejects.toMatchObject({ code: 'source-unreachable' })
    mocks.fetch.mockResolvedValueOnce(new Response('not json'))
    await expect(lookupRelease(source, '2.1.310')).rejects.toMatchObject({ code: 'invalid-manifest' })
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ version: '2.1.310', platforms: {} })))
    await expect(lookupRelease(source, '2.1.310')).rejects.toMatchObject({ code: 'unsupported-platform' })
  })

  it('bounds a stalled source and really aborts the metadata request', async () => {
    let aborted = false
    mocks.fetch.mockImplementation((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
      aborted = true
      reject(options.signal.reason)
    })))
    const start = Date.now()
    await expect(lookupRelease(source, '2.1.310', { timeoutMs: 30 })).rejects.toMatchObject({ code: 'source-timeout' })
    expect(aborted).toBe(true)
    expect(Date.now() - start).toBeLessThan(500)
  })

  it('bounds metadata body size', async () => {
    mocks.fetch.mockResolvedValue(new Response('x'.repeat(129 * 1024)))
    await expect(lookupRelease(source, '2.1.310')).rejects.toMatchObject({ code: 'invalid-manifest' })
  })
})
