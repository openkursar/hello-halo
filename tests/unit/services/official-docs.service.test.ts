/**
 * Official AI guide delivery tests
 *
 * The failure modes that matter here are all silent: a path that escapes the
 * guide tree, an SPA shell served as if it were the guide, or an offline
 * machine getting nothing at all — the last one would deadlock
 * create_automation_app, whose precondition assumes a read can always succeed.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const APP_ROOT = join(tmpdir(), 'halo-official-docs-test')
const GUIDE_ROOT = join(APP_ROOT, 'resources', 'ai-guides')
const BASE_URL = 'http://docs.internal/ai-guides'

vi.mock('electron', () => ({
  app: { getAppPath: () => APP_ROOT },
}))

vi.mock('../../../src/main/foundation/product-config', () => ({
  getOfficialContentBaseUrl: () => BASE_URL,
}))

const proxyFetch = vi.fn()
vi.mock('../../../src/main/services/proxy-fetch', () => ({
  proxyFetch: (...args: unknown[]) => proxyFetch(...args),
}))

const { readOfficialDoc, clearOfficialDocsCache } = await import(
  '../../../src/main/services/official-docs.service'
)

function textResponse(body: string, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: 'OK',
    headers: { get: () => null },
    text: async () => body,
  }
}

beforeAll(() => {
  mkdirSync(join(GUIDE_ROOT, 'create-digital-human'), { recursive: true })
  writeFileSync(join(GUIDE_ROOT, 'create-digital-human', 'SKILL.md'), '# Bundled entry')
  writeFileSync(join(GUIDE_ROOT, 'create-digital-human', 'im-triggers.md'), '# Bundled IM')
  writeFileSync(join(GUIDE_ROOT, 'SNAPSHOT.json'), JSON.stringify({ syncedAt: '2026-09-03' }))
  writeFileSync(join(APP_ROOT, 'outside-the-tree.md'), '# Must never be readable')
})

afterAll(() => {
  rmSync(APP_ROOT, { recursive: true, force: true })
})

beforeEach(() => {
  clearOfficialDocsCache()
  proxyFetch.mockReset()
})

describe('readOfficialDoc path validation', () => {
  it.each([
    ['absolute path', '/etc/passwd.md'],
    ['parent traversal', 'create-digital-human/../../outside-the-tree.md'],
    ['full URL', 'http://evil.example.com/x.md'],
    ['non-markdown', 'create-digital-human/SKILL.txt'],
    ['empty', '   '],
  ])('rejects %s without touching the network', async (_label, path) => {
    const result = await readOfficialDoc(path)

    expect(result.ok).toBe(false)
    expect(proxyFetch).not.toHaveBeenCalled()
  })

  it('lists what is available offline when a path cannot be served', async () => {
    proxyFetch.mockRejectedValue(new Error('offline'))

    const result = await readOfficialDoc('create-digital-human/missing.md')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.available).toContain('create-digital-human/SKILL.md')
  })
})

describe('readOfficialDoc tiers', () => {
  it('serves the live document and appends the path to the configured base', async () => {
    proxyFetch.mockResolvedValue(textResponse('# Remote entry'))

    const result = await readOfficialDoc('create-digital-human/SKILL.md')

    expect(proxyFetch).toHaveBeenCalledWith(
      `${BASE_URL}/create-digital-human/SKILL.md`,
      expect.anything()
    )
    expect(result).toMatchObject({ ok: true, source: 'remote', text: '# Remote entry' })
  })

  it('reuses the cached copy instead of re-fetching within the TTL', async () => {
    proxyFetch.mockResolvedValue(textResponse('# Remote entry'))
    await readOfficialDoc('create-digital-human/SKILL.md')

    const result = await readOfficialDoc('create-digital-human/SKILL.md')

    expect(proxyFetch).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: true, source: 'cache' })
  })

  it('falls back to the bundled snapshot when the host is unreachable', async () => {
    proxyFetch.mockRejectedValue(new Error('ENOTFOUND'))

    const result = await readOfficialDoc('create-digital-human/SKILL.md')

    expect(result).toMatchObject({ ok: true, source: 'bundled', snapshotDate: '2026-09-03' })
  })

  it('treats an HTTP error page as unreachable rather than as content', async () => {
    proxyFetch.mockResolvedValue(textResponse('Not Found', { ok: false, status: 404 }))

    const result = await readOfficialDoc('create-digital-human/im-triggers.md')

    expect(result).toMatchObject({ ok: true, source: 'bundled', text: '# Bundled IM' })
  })

  it('rejects an SPA shell served in place of markdown', async () => {
    proxyFetch.mockResolvedValue(textResponse('<!DOCTYPE html><html><body>docs</body></html>'))

    const result = await readOfficialDoc('create-digital-human/SKILL.md')

    expect(result).toMatchObject({ ok: true, source: 'bundled', text: '# Bundled entry' })
  })

  it('rejects a body over the size cap', async () => {
    proxyFetch.mockResolvedValue(textResponse('x'.repeat(512 * 1024 + 1)))

    const result = await readOfficialDoc('create-digital-human/SKILL.md')

    expect(result).toMatchObject({ ok: true, source: 'bundled' })
  })
})
