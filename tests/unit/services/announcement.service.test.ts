/**
 * Announcement service tests
 *
 * The feed is server-authored and reaches every user, so the failure modes that
 * matter are the quiet ones: an entry that repeats forever because dedup broke,
 * a retracted entry that keeps showing because the schedule window is ignored,
 * or a hostile URL surviving into a clickable button. Each is pinned here
 * because none of them would be obvious at runtime.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Announcement } from '../../../src/shared/types/announcement'

const FEED_URL = 'http://feed.internal/announcements.json'

let feedUrl: string | undefined = FEED_URL
let appVersion = '2.1.14'

vi.mock('electron', () => ({
  app: {
    getVersion: () => appVersion,
    getPath: () => '/tmp/halo-test',
  },
}))

vi.mock('../../../src/main/foundation/product-config', () => ({
  getAnnouncementsUrl: () => feedUrl,
}))

/** Mirrors pushToast's contract: true when a client actually received it. */
const pushToast = vi.fn<(payload: unknown) => boolean>(() => true)
vi.mock('../../../src/main/services/notification.service', () => ({
  pushToast: (payload: unknown) => pushToast(payload),
}))

const proxyFetch = vi.fn()
vi.mock('../../../src/main/services/proxy-fetch', () => ({
  proxyFetch: (...args: unknown[]) => proxyFetch(...args),
}))

/** In-memory stand-in for the dedup state file. */
let diskFile: string | null = null
vi.mock('fs', () => ({
  existsSync: () => diskFile !== null,
  readFileSync: () => diskFile ?? '',
  writeFileSync: (_path: string, data: string) => { diskFile = data },
  mkdirSync: () => undefined,
}))

function feedResponse(entries: unknown, init?: { status?: number; etag?: string }) {
  const body = JSON.stringify(entries)
  return {
    ok: (init?.status ?? 200) < 400,
    status: init?.status ?? 200,
    statusText: 'OK',
    headers: {
      get: (name: string) => (name.toLowerCase() === 'etag' ? init?.etag ?? null : null),
    },
    text: async () => body,
  }
}

async function checkNow() {
  const module = await import('../../../src/main/services/announcement.service')
  return module.checkAnnouncementsNow()
}

/** Titles of every announcement pushed to the renderer so far. */
function shownTitles(): string[] {
  return pushToast.mock.calls.map(([payload]) => (payload as { title: string }).title)
}

const BASIC: Announcement = { id: 'a1', title: 'Scheduled maintenance' }

describe('announcement.service', () => {
  beforeEach(() => {
    vi.resetModules()
    pushToast.mockClear()
    pushToast.mockReturnValue(true)
    proxyFetch.mockReset()
    diskFile = null
    feedUrl = FEED_URL
    appVersion = '2.1.14'
  })

  it('does nothing when the build has no feed configured', async () => {
    feedUrl = undefined

    expect(await checkNow()).toBe(0)
    expect(proxyFetch).not.toHaveBeenCalled()
  })

  it('shows a due announcement', async () => {
    proxyFetch.mockResolvedValue(feedResponse({ announcements: [BASIC] }))

    expect(await checkNow()).toBe(1)
    expect(shownTitles()).toEqual(['Scheduled maintenance'])
  })

  it('accepts a bare array feed', async () => {
    proxyFetch.mockResolvedValue(feedResponse([BASIC]))

    expect(await checkNow()).toBe(1)
  })

  it('never shows the same id twice, even across restarts', async () => {
    proxyFetch.mockResolvedValue(feedResponse({ announcements: [BASIC] }))
    await checkNow()

    // Fresh module instance = new process; only the state file carries over.
    vi.resetModules()
    expect(await checkNow()).toBe(0)
    expect(pushToast).toHaveBeenCalledTimes(1)
  })

  it('retries an announcement that reached no client', async () => {
    // Window closed with no remote client attached: recording it as shown would
    // retire the entry without anyone ever reading it.
    pushToast.mockReturnValue(false)
    proxyFetch.mockResolvedValue(feedResponse({ announcements: [BASIC] }))

    expect(await checkNow()).toBe(0)
    expect(diskFile).toBeNull()

    pushToast.mockReturnValue(true)
    vi.resetModules()
    expect(await checkNow()).toBe(1)
  })

  it('honours the schedule window', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString()
    const past = new Date(Date.now() - 86_400_000).toISOString()

    proxyFetch.mockResolvedValue(feedResponse({
      announcements: [
        { id: 'not-yet', title: 'Future', startsAt: future },
        { id: 'expired', title: 'Expired', expiresAt: past },
        { id: 'live', title: 'Live', startsAt: past, expiresAt: future },
      ],
    }))

    expect(await checkNow()).toBe(1)
    expect(shownTitles()).toEqual(['Live'])
  })

  it('targets a version range, ignoring pre-release suffixes', async () => {
    appVersion = '2.1.13-rc.2'
    proxyFetch.mockResolvedValue(feedResponse({
      announcements: [
        { id: 'old-only', title: 'Please upgrade', maxVersion: '2.1.13' },
        { id: 'new-only', title: 'New feature tour', minVersion: '2.2.0' },
      ],
    }))

    expect(await checkNow()).toBe(1)
    expect(shownTitles()).toEqual(['Please upgrade'])
  })

  it('drops an action whose URL is not http(s)', async () => {
    proxyFetch.mockResolvedValue(feedResponse({
      announcements: [
        { id: 'safe', title: 'Safe', action: { label: 'Docs', url: 'https://example.com' } },
        { id: 'unsafe', title: 'Unsafe', action: { label: 'Run', url: 'javascript:alert(1)' } },
        { id: 'local', title: 'Local', action: { label: 'Open', url: 'file:///etc/passwd' } },
      ],
    }))

    await checkNow()

    const actions = pushToast.mock.calls.map(([payload]) => (payload as { action?: unknown }).action)
    expect(actions).toEqual([
      { label: 'Docs', url: 'https://example.com' },
      undefined,
      undefined,
    ])
  })

  it('skips malformed entries without dropping the rest of the feed', async () => {
    proxyFetch.mockResolvedValue(feedResponse({
      announcements: [
        { title: 'No id' },
        { id: 'no-title' },
        null,
        'not an object',
        BASIC,
      ],
    }))

    expect(await checkNow()).toBe(1)
    expect(shownTitles()).toEqual(['Scheduled maintenance'])
  })

  it('treats an unchanged feed (304) as a no-op', async () => {
    proxyFetch.mockResolvedValue(feedResponse({ announcements: [BASIC] }, { status: 304 }))

    expect(await checkNow()).toBe(0)
    expect(pushToast).not.toHaveBeenCalled()
  })

  it('survives a feed host that is down', async () => {
    proxyFetch.mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(checkNow()).resolves.toBe(0)
    expect(pushToast).not.toHaveBeenCalled()
  })

  it('survives a feed that is not valid JSON', async () => {
    proxyFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '<html>404</html>',
    })

    await expect(checkNow()).resolves.toBe(0)
    expect(pushToast).not.toHaveBeenCalled()
  })

  it('forwards the body format so server copy can use markdown', async () => {
    proxyFetch.mockResolvedValue(feedResponse({
      announcements: [{ id: 'rich', title: 'Release', body: '- one\n- two', bodyFormat: 'markdown' }],
    }))

    await checkNow()

    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({
      bodyFormat: 'markdown',
      body: '- one\n- two',
    }))
  })
})
