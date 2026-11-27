import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { OrgBrowserCookies, validBrowserCookies } from '../../../src/main/services/enterprise-identity/browser-cookies'
import type { OrgBrowserCookie } from '../../../src/shared/interfaces/enterprise-identity-provider'

const HOUR = 3600_000
const NOW = Date.UTC(2026, 10, 26, 12)

function fakeStore() {
  const jar = new Map<string, { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; expirationDate: number }>()
  const hostOf = (url: string) => new URL(url).hostname
  const store = {
    jar,
    set: vi.fn(async (details: any) => {
      const domain = details.domain ?? hostOf(details.url)
      jar.set(`${domain}|${details.path}|${details.name}`, { ...details, domain })
    }),
    remove: vi.fn(async (url: string, name: string) => {
      const host = hostOf(url)
      for (const key of [...jar.keys()]) {
        const cookie = jar.get(key)!
        if (cookie.name === name && cookie.domain.replace(/^\./, '') === host) jar.delete(key)
      }
    }),
    get: vi.fn(async ({ domain }: { domain?: string }) => [...jar.values()].filter(cookie => {
      const bare = cookie.domain.replace(/^\./, '')
      return !domain || bare === domain || bare.endsWith(`.${domain}`)
    })),
  }
  stores.push(store)
  return store
}

function provider(cookies: () => OrgBrowserCookie[]) {
  return { browserCookies: vi.fn(async () => cookies()) } as any
}

const ticket = (value: string, expiresAt = NOW + 2 * HOUR): OrgBrowserCookie => ({ domain: '.example.com', name: 'TICKET', value, expiresAt })
// File writes finish in real time, which fake timers do not drive: wait until
// the stores and records stop changing, so a loaded machine cannot cut it short.
const realSetTimeout = globalThis.setTimeout
const stores: Array<Record<'set' | 'remove' | 'get', { mock: { calls: unknown[] } }>> = []
const records = new Set<string>()
function observed(): string {
  const files = [...records].map(file => existsSync(file) ? readFileSync(file, 'utf8') : '')
  return JSON.stringify([stores.map(store => [store.set.mock.calls.length, store.remove.mock.calls.length, store.get.mock.calls.length]), files])
}
const flush = async () => {
  let last = ''
  for (let round = 0, stable = 0; round < 500 && (round < 20 || stable < 10); round++) {
    await new Promise(resolve => realSetTimeout(resolve, 3))
    await vi.advanceTimersByTimeAsync(0)
    const now = observed()
    stable = now === last ? stable + 1 : 0
    last = now
  }
}

describe('organization browser cookies', () => {
  let recordFile: string
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(NOW)
    recordFile = join(globalThis.__HALO_TEST_DIR__, `cookies-${Math.random()}.json`)
    stores.length = 0
    records.clear()
    records.add(recordFile).add(`${recordFile}.2`)
  })
  afterEach(() => { vi.useRealTimers() })

  it('validates what the provider returns as one batch', () => {
    expect(validBrowserCookies([ticket('abc')], NOW)).toHaveLength(1)
    for (const bad of [
      { ...ticket('abc'), domain: '127.0.0.1' }, { ...ticket('abc'), domain: 'localhost' }, { ...ticket('abc'), domain: 'com' },
      { ...ticket('abc'), name: 'bad name' }, { ...ticket('a;b') }, { ...ticket('') }, { ...ticket('abc', NOW - 1) },
      { ...ticket('abc'), path: 'relative' },
    ]) expect(validBrowserCookies([ticket('ok'), bad], NOW)).toBeNull()
    expect(validBrowserCookies([ticket('a'), ticket('b')], NOW)).toBeNull()
    expect(validBrowserCookies(Array.from({ length: 17 }, (_, i) => ({ ...ticket('a'), name: `N${i}` })), NOW)).toBeNull()
  })

  it('writes HttpOnly cookies while signed in, renews before expiry and removes only its own on withdrawal', async () => {
    const store = fakeStore()
    let value = 'first'
    const p = provider(() => [ticket(value)])
    const cookies = new OrgBrowserCookies({ store: () => store, recordFile })
    await store.set({ url: 'http://docs.example.com/', name: 'SITE', value: 'mine', path: '/', secure: false, httpOnly: true, sameSite: 'lax', expirationDate: 0 })
    cookies.sync(p, 'alice', 'alice|intranet')
    await flush()
    expect(store.jar.get('.example.com|/|TICKET')).toMatchObject({ value: 'first', httpOnly: true, secure: false, expirationDate: Math.floor((NOW + 2 * HOUR) / 1000) })
    expect(store.set.mock.calls.at(-1)![0]).toMatchObject({ url: 'http://example.com/', domain: '.example.com', sameSite: 'lax' })
    const record = JSON.parse(readFileSync(recordFile, 'utf8'))
    expect(JSON.stringify(record)).not.toContain('first')
    expect(JSON.stringify(record)).not.toContain('alice')

    value = 'second'
    await vi.advanceTimersByTimeAsync(2 * HOUR - 60_000 - 1)
    expect(store.jar.get('.example.com|/|TICKET')!.value).toBe('first')
    await vi.advanceTimersByTimeAsync(2)
    await flush()
    expect(store.jar.get('.example.com|/|TICKET')!.value).toBe('second')

    await cookies.withdraw()
    expect(store.jar.has('.example.com|/|TICKET')).toBe(false)
    expect(store.jar.has('docs.example.com|/|SITE')).toBe(true)
  })

  it('ends the previous person\'s page sessions when a different person signs in, also after a restart', async () => {
    const store = fakeStore()
    const first = new OrgBrowserCookies({ store: () => store, recordFile })
    first.sync(provider(() => [ticket('alice-ticket')]), 'alice', 'alice|intranet')
    await flush()
    await store.set({ url: 'http://docs.example.com/', name: 'SITE', value: 'alice-session', path: '/', secure: false, httpOnly: true, sameSite: 'lax', expirationDate: 0 })
    await first.withdraw()
    expect(store.jar.has('docs.example.com|/|SITE')).toBe(true)

    const restarted = new OrgBrowserCookies({ store: () => store, recordFile })
    restarted.sync(provider(() => [ticket('alice-again')]), 'alice', 'alice|intranet')
    await flush()
    expect(store.jar.has('docs.example.com|/|SITE')).toBe(true)
    await restarted.withdraw()

    restarted.sync(provider(() => [ticket('bob-ticket')]), 'bob', 'bob|intranet')
    await flush()
    expect(store.jar.has('docs.example.com|/|SITE')).toBe(false)
    expect(store.jar.get('.example.com|/|TICKET')!.value).toBe('bob-ticket')
  })

  it('removes cookies a crashed run left behind before anything else', async () => {
    const store = fakeStore()
    await store.set({ url: 'http://example.com/', domain: '.example.com', name: 'TICKET', value: 'stale', path: '/', secure: false, httpOnly: true, sameSite: 'lax', expirationDate: 0 })
    writeFileSync(recordFile, JSON.stringify({ salt: 'a'.repeat(32), domains: ['.example.com'], cookies: [{ domain: '.example.com', path: '/', name: 'TICKET', secure: false }] }))
    const cookies = new OrgBrowserCookies({ store: () => store, recordFile })
    cookies.sync(undefined, undefined, null)
    await flush()
    expect(store.jar.size).toBe(0)
  })

  it('backs off after a failure, retries on request, and never runs without a provider method', async () => {
    const store = fakeStore()
    let fail = true
    const p = { browserCookies: vi.fn(async () => { if (fail) throw new Error('offline'); return [ticket('ok')] }) } as any
    const cookies = new OrgBrowserCookies({ store: () => store, recordFile, log: { error() {}, warn() {}, info() {} } })
    cookies.sync(p, 'alice', 'alice|intranet')
    await flush()
    expect(p.browserCookies).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(29_000)
    expect(p.browserCookies).toHaveBeenCalledTimes(1)
    fail = false
    cookies.sync(p, 'alice', 'alice|intranet', true)
    await flush()
    expect(store.jar.get('.example.com|/|TICKET')!.value).toBe('ok')

    const silent = new OrgBrowserCookies({ store: () => store, recordFile: `${recordFile}.2` })
    silent.sync({} as any, 'alice', 'alice|intranet')
    await flush()
    expect(existsSync(`${recordFile}.2`)).toBe(false)
  })

  it('keeps nothing longer than thirty days', async () => {
    const store = fakeStore()
    const cookies = new OrgBrowserCookies({ store: () => store, recordFile })
    cookies.sync(provider(() => [ticket('long', NOW + 365 * 24 * HOUR)]), 'alice', 'alice|intranet')
    await flush()
    expect(store.jar.get('.example.com|/|TICKET')!.expirationDate).toBe(Math.floor((NOW + 30 * 24 * HOUR) / 1000))
  })
})
