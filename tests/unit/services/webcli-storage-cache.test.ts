import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sessionStorageValue } from '../../../src/main/services/webcli-host/storage-cache'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('../../../src/main/foundation/config.service', () => ({ getHaloDir: () => state.root }))
vi.mock('../../../src/main/foundation/crypto-envelope', () => ({
  encodeForStorage: (value: string) => `encoded:${Buffer.from(value).toString('base64')}`,
  tryDecodeFromStorage: (value: string) => value.startsWith('encoded:')
    ? { ok: true, value: Buffer.from(value.slice(8), 'base64').toString() } : { ok: false, reason: 'fixture-invalid' },
}))
const scope = { adapter: 'example.com', origin: 'https://example.com', key: 'fixture-token' }
const signal = () => new AbortController().signal
beforeEach(() => { state.root = join(globalThis.__HALO_TEST_DIR__, randomUUID()) })

describe('browser session storage cache', () => {
  it('evicts the oldest entry at its fixed bound even when timestamps coincide', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      for (let key = 0; key < 65; key++) await sessionStorageValue({ ...scope, key: String(key) }, {}, signal(), async () => ({ value: 'fixture' }))
      const saved = JSON.parse(await readFile(join(state.root, 'webcli/session-storage.json'), 'utf8'))
      expect(Object.keys(saved.entries)).toHaveLength(64)
      await expect(sessionStorageValue({ ...scope, key: '0' }, { cacheOnly: true }, signal(), async () => ({ value: null }))).rejects.toMatchObject({ code: 'PAGE_CONTEXT_REQUIRED' })
      expect(await sessionStorageValue({ ...scope, key: '64' }, { cacheOnly: true }, signal(), async () => ({ value: null }))).toEqual({ value: 'fixture' })
    } finally { clock.mockRestore() }
  })
  it('reads the persisted envelope and isolates Adapter, scheme, port, key and profile', async () => {
    const read = vi.fn(async () => ({ value: 'fixture-secret' }))
    expect(await sessionStorageValue(scope, {}, signal(), read)).toEqual({ value: 'fixture-secret' })
    expect(await sessionStorageValue(scope, { cacheOnly: true }, signal(), read)).toEqual({ value: 'fixture-secret' })
    expect(read).toHaveBeenCalledTimes(1)
    const saved = await readFile(join(state.root, 'webcli/session-storage.json'), 'utf8')
    expect(saved).not.toContain('fixture-secret')
    expect(JSON.parse(saved).version).toBe(1)
    for (const other of [{ ...scope, adapter: 'other.example.com' }, { ...scope, origin: 'http://example.com' },
      { ...scope, origin: 'https://example.com:444' }, { ...scope, key: 'other' }]) {
      await expect(sessionStorageValue(other, { cacheOnly: true }, signal(), read)).rejects.toMatchObject({ code: 'PAGE_CONTEXT_REQUIRED' })
    }
    state.root += '-other'
    await expect(sessionStorageValue(scope, { cacheOnly: true }, signal(), read)).rejects.toMatchObject({ code: 'PAGE_CONTEXT_REQUIRED' })
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('invalidates stale data on forced empty, failed or cancelled refresh without replay', async () => {
    const read = vi.fn(async () => ({ value: 'fixture-old' }))
    await sessionStorageValue(scope, {}, signal(), read)
    const refresh = vi.fn(async () => { throw new Error('fixture refresh failed') })
    await expect(sessionStorageValue(scope, { forceRefresh: true }, signal(), refresh)).rejects.toThrow('fixture refresh failed')
    await expect(sessionStorageValue(scope, { cacheOnly: true }, signal(), read)).rejects.toMatchObject({ code: 'PAGE_CONTEXT_REQUIRED' })
    expect(refresh).toHaveBeenCalledTimes(1)
    await sessionStorageValue(scope, {}, signal(), read)
    expect(await sessionStorageValue(scope, { forceRefresh: true }, signal(), async () => ({ value: null }))).toEqual({ value: null })
    await expect(sessionStorageValue(scope, { cacheOnly: true }, signal(), read)).rejects.toMatchObject({ code: 'PAGE_CONTEXT_REQUIRED' })
    const controller = new AbortController()
    await expect(sessionStorageValue(scope, {}, controller.signal, async () => {
      controller.abort(new Error('fixture cancelled')); return { value: 'fixture-cancelled' }
    })).rejects.toThrow('fixture cancelled')
    await expect(sessionStorageValue(scope, { cacheOnly: true }, signal(), read)).rejects.toMatchObject({ code: 'PAGE_CONTEXT_REQUIRED' })
  })
  it('serializes same-key refresh and preserves independent concurrent updates', async () => {
    const read = vi.fn(async () => ({ value: 'fixture-value' }))
    await Promise.all([sessionStorageValue(scope, {}, signal(), read), sessionStorageValue(scope, {}, signal(), read),
      sessionStorageValue({ ...scope, key: 'second' }, {}, signal(), async () => ({ value: 'fixture-second' }))])
    expect(read).toHaveBeenCalledTimes(1)
    expect(await sessionStorageValue({ ...scope, key: 'second' }, { cacheOnly: true }, signal(), read)).toEqual({ value: 'fixture-second' })
  })
  it('rejects oversized values and preserves corrupt or undecodable persisted data', async () => {
    await expect(sessionStorageValue(scope, {}, signal(), async () => ({ value: 'x'.repeat(64001) }))).rejects.toMatchObject({ code: 'HOST_PAYLOAD_TOO_LARGE' })
    await sessionStorageValue(scope, {}, signal(), async () => ({ value: 'fixture' }))
    const file = join(state.root, 'webcli/session-storage.json')
    const cache = JSON.parse(await readFile(file, 'utf8'))
    Object.values(cache.entries).forEach((entry: any) => { entry.value = 'invalid-envelope' })
    await writeFile(file, JSON.stringify(cache))
    await expect(sessionStorageValue(scope, {}, signal(), async () => ({ value: 'replacement' }))).rejects.toMatchObject({ code: 'HOST_STORAGE_CACHE_UNAVAILABLE' })
    expect(await readFile(file, 'utf8')).toContain('invalid-envelope')
    await writeFile(file, 'broken fixture')
    await expect(sessionStorageValue(scope, {}, signal(), async () => ({ value: null }))).rejects.toMatchObject({ code: 'HOST_STORAGE_CACHE_UNAVAILABLE' })
    expect(await readFile(file, 'utf8')).toBe('broken fixture')
  })
})
