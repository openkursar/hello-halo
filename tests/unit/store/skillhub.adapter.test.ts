/**
 * Unit tests for SkillHubAdapter
 *
 * Tests the adapter in isolation by mocking global fetch.
 * Verifies query pagination, spec fetching, category mapping, and error paths.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

// Stub proxy-fetch so fetchWithTimeout falls through to the global fetch mock
// without touching electron.session (not available in Node test environment).
vi.mock('../../../src/main/services/proxy-fetch', () => ({
  proxyFetch: (url: string, init?: RequestInit) => fetch(url, init),
}))

import { SkillHubAdapter } from '../../../src/main/store/adapters/skillhub.adapter'
import type { RegistrySource, RegistryEntry, StoreQueryParams } from '../../../src/shared/store/store-types'

// ── Fixtures ───────────────────────────────────────────────────────────────

const MOCK_SOURCE: RegistrySource = {
  id: 'skillhub',
  name: 'SkillHub',
  url: 'https://api.skillhub.cn',
  enabled: true,
  sourceType: 'skillhub',
}

const MOCK_SKILL = {
  slug: 'code-review',
  name: 'Code Review',
  description: 'Automated code review assistant',
  description_zh: '自动代码审查助手',
  category: 'DeveloperTools',
  tags: ['code', 'review', 'quality'],
  ownerName: 'community-author',
  version: '1.2.0',
  stars: 42,
  installs: 100,
  source: 'openclaw',
  iconUrl: 'https://example.com/icon.png',
  created_at: 1700000000000,
  updated_at: 1710000000000,
}

const MOCK_LIST_RESPONSE = {
  code: 0,
  message: 'success',
  data: {
    skills: [MOCK_SKILL],
    total: 33275,
  },
}

const MOCK_FILES_RESPONSE = {
  count: 1,
  version: 'v1.2.0',
  files: [{ path: 'SKILL.md', sha256: 'abc123', size: 1024 }],
}

const MOCK_SKILL_MD = `# Code Review Skill

## Overview
This skill helps you review code.

## Usage
Ask me to review your code.
`

// ── Helpers ────────────────────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain' },
  })
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('SkillHubAdapter', () => {
  let adapter: SkillHubAdapter
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    adapter = new SkillHubAdapter()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  // ── Strategy ─────────────────────────────────────────────────────────────

  it('declares proxy strategy', () => {
    expect(adapter.strategy).toBe('proxy')
  })

  // ── query() ──────────────────────────────────────────────────────────────

  describe('query()', () => {
    it('fetches page 1 and maps skills to RegistryEntry', async () => {
      const params: StoreQueryParams = { page: 1, pageSize: 24 }

      fetchMock.mockResolvedValueOnce(jsonResponse(MOCK_LIST_RESPONSE))

      const result = await adapter.query(MOCK_SOURCE, params)

      expect(fetchMock).toHaveBeenCalledOnce()
      const url = String(fetchMock.mock.calls[0][0])
      expect(url).toContain('api.skillhub.cn/api/skills')
      expect(url).toContain('page=1')
      expect(url).toContain('pageSize=24')

      expect(result.items).toHaveLength(1)
      expect(result.total).toBe(33275)
      expect(result.hasMore).toBe(true)
    })

    it('maps skill fields to RegistryEntry correctly', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(MOCK_LIST_RESPONSE))

      const result = await adapter.query(MOCK_SOURCE, { page: 1, pageSize: 24 })
      const entry = result.items[0]

      expect(entry.slug).toBe('code-review')
      expect(entry.name).toBe('Code Review')
      expect(entry.description).toBe('Automated code review assistant')
      expect(entry.version).toBe('1.2.0')
      expect(entry.author).toBe('community-author')
      expect(entry.type).toBe('skill')
      expect(entry.format).toBe('bundle')
      expect(entry.tags).toEqual(['code', 'review', 'quality'])
      expect(entry.icon).toBe('https://example.com/icon.png')
      expect(entry.i18n?.['zh-CN']?.description).toBe('自动代码审查助手')
      expect(entry.meta?.rank).toBe(42)
      expect(entry.meta?.installs).toBe(100)
    })

    it('appends search param when search is provided', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ...MOCK_LIST_RESPONSE, data: { skills: [], total: 0 } }))

      await adapter.query(MOCK_SOURCE, { page: 1, pageSize: 10, search: 'code review' })

      const url = String(fetchMock.mock.calls[0][0])
      expect(url).toContain('search=code%20review')
    })

    it('appends category param when category is provided', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ...MOCK_LIST_RESPONSE, data: { skills: [], total: 0 } }))

      await adapter.query(MOCK_SOURCE, { page: 1, pageSize: 24, category: 'dev-tools' })

      const url = String(fetchMock.mock.calls[0][0])
      expect(url).toContain('category=dev-tools')
    })

    it('caps pageSize at 100', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(MOCK_LIST_RESPONSE))

      await adapter.query(MOCK_SOURCE, { page: 1, pageSize: 999 })

      const url = String(fetchMock.mock.calls[0][0])
      expect(url).toContain('pageSize=100')
    })

    it('sets hasMore=false on last page', async () => {
      const lastPageResponse = {
        code: 0,
        message: 'success',
        data: { skills: [MOCK_SKILL], total: 1 },
      }

      fetchMock.mockResolvedValueOnce(jsonResponse(lastPageResponse))

      const result = await adapter.query(MOCK_SOURCE, { page: 1, pageSize: 24 })
      expect(result.hasMore).toBe(false)
    })

    it('throws on HTTP error response', async () => {
      fetchMock.mockResolvedValueOnce(new Response('Not Found', { status: 404, statusText: 'Not Found' }))

      await expect(adapter.query(MOCK_SOURCE, { page: 1, pageSize: 24 })).rejects.toThrow(
        /SkillHub API error HTTP 404/
      )
    })

    it('throws when API code is non-zero', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ code: 1, message: 'internal error', data: null })
      )

      await expect(adapter.query(MOCK_SOURCE, { page: 1, pageSize: 24 })).rejects.toThrow(
        /SkillHub API returned error/
      )
    })

    it('skips skills with missing slug or name', async () => {
      const responseWithInvalid = {
        code: 0,
        message: 'success',
        data: {
          skills: [
            MOCK_SKILL,
            { slug: '', name: 'No Slug', description: 'bad' },
            { slug: 'no-name', description: 'bad' },
          ],
          total: 3,
        },
      }

      fetchMock.mockResolvedValueOnce(jsonResponse(responseWithInvalid))

      const result = await adapter.query(MOCK_SOURCE, { page: 1, pageSize: 24 })
      expect(result.items).toHaveLength(1)
      expect(result.items[0].slug).toBe('code-review')
    })

    it('uses default values for missing optional fields', async () => {
      const minimalSkill = { slug: 'minimal', name: 'Minimal Skill' }
      const response = {
        code: 0,
        message: 'success',
        data: { skills: [minimalSkill], total: 1 },
      }

      fetchMock.mockResolvedValueOnce(jsonResponse(response))

      const result = await adapter.query(MOCK_SOURCE, { page: 1, pageSize: 24 })
      const entry = result.items[0]

      expect(entry.version).toBe('1.0')
      expect(entry.author).toBe('community')
      expect(entry.description).toBe('Minimal Skill')
      expect(entry.tags).toEqual([])
      expect(entry.category).toBe('other')
      expect(entry.i18n).toBeUndefined()
    })
  })

  // ── Category mapping ──────────────────────────────────────────────────────

  describe('category mapping (via query)', () => {
    async function querySingleCategory(category: string): Promise<string> {
      const response = {
        code: 0,
        message: 'success',
        data: { skills: [{ ...MOCK_SKILL, category }], total: 1 },
      }
      fetchMock.mockResolvedValueOnce(jsonResponse(response))
      const result = await adapter.query(MOCK_SOURCE, { page: 1, pageSize: 24 })
      return result.items[0].category
    }

    it.each([
      ['DeveloperTools', 'dev-tools'],
      ['coding-assistant', 'dev-tools'],
      ['data-analysis', 'data'],
      ['content-creation', 'content'],
      ['writing-tools', 'content'],
      ['productivity', 'productivity'],
      ['workflow', 'productivity'],
      ['social-media', 'social'],
      ['chat-helpers', 'social'],
      ['news-reader', 'news'],
      ['web-search', 'news'],
      ['unknown-category', 'other'],
      [undefined as unknown as string, 'other'],
    ])('maps %s → %s', async (input, expected) => {
      const mapped = await querySingleCategory(input)
      expect(mapped).toBe(expected)
    })
  })

  // ── fetchSpec() ───────────────────────────────────────────────────────────

  describe('fetchSpec()', () => {
    const MOCK_ENTRY: RegistryEntry = {
      slug: 'code-review',
      name: 'Code Review',
      version: '1.2.0',
      author: 'community-author',
      description: 'Automated code review assistant',
      type: 'skill',
      format: 'bundle',
      path: 'code-review',
      category: 'dev-tools',
      tags: ['code', 'review'],
    }

    it('fetches file manifest then downloads SKILL.md from COS', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(MOCK_FILES_RESPONSE))
        .mockResolvedValueOnce(textResponse(MOCK_SKILL_MD))

      const spec = await adapter.fetchSpec(MOCK_SOURCE, MOCK_ENTRY)

      expect(fetchMock).toHaveBeenCalledTimes(2)

      // First call: files manifest
      const manifestUrl = String(fetchMock.mock.calls[0][0])
      expect(manifestUrl).toContain('api.skillhub.cn/api/v1/skills/code-review/files')

      // Second call: SKILL.md from COS
      const cosUrl = String(fetchMock.mock.calls[1][0])
      expect(cosUrl).toContain('code-review/v1.2.0/files/SKILL.md')
      expect(cosUrl).toContain('skillhub-1388575217.cos.accelerate.myqcloud.com')
    })

    it('returns a valid SkillSpec with SKILL.md content', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(MOCK_FILES_RESPONSE))
        .mockResolvedValueOnce(textResponse(MOCK_SKILL_MD))

      const spec = await adapter.fetchSpec(MOCK_SOURCE, MOCK_ENTRY)

      expect(spec.spec_version).toBe('1')
      expect(spec.type).toBe('skill')
      expect(spec.name).toBe('Code Review')
      expect(spec.version).toBe('1.2.0')
      expect(spec.author).toBe('community-author')
      const skillSpec = spec as import('../../../src/main/apps/spec/schema').SkillSpec
      expect(skillSpec.skill_files?.['SKILL.md']).toBe(MOCK_SKILL_MD)
      expect(spec.store?.slug).toBe('code-review')
    })

    it('sets registry_id from the source', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(MOCK_FILES_RESPONSE))
        .mockResolvedValueOnce(textResponse(MOCK_SKILL_MD))

      const spec = await adapter.fetchSpec(MOCK_SOURCE, MOCK_ENTRY)

      expect(spec.store?.registry_id).toBe('skillhub')
    })

    it('throws when files API returns HTTP error', async () => {
      fetchMock.mockResolvedValueOnce(new Response('Not Found', { status: 404, statusText: 'Not Found' }))

      await expect(adapter.fetchSpec(MOCK_SOURCE, MOCK_ENTRY)).rejects.toThrow(
        /SkillHub files API error HTTP 404/
      )
    })

    it('throws when files manifest has no version', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ count: 0, version: '', files: [] })
      )

      await expect(adapter.fetchSpec(MOCK_SOURCE, MOCK_ENTRY)).rejects.toThrow(
        /no version/i
      )
    })

    it('throws when SKILL.md download fails', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(MOCK_FILES_RESPONSE))
        .mockResolvedValueOnce(new Response('Forbidden', { status: 403, statusText: 'Forbidden' }))

      await expect(adapter.fetchSpec(MOCK_SOURCE, MOCK_ENTRY)).rejects.toThrow(
        /failed to download "SKILL\.md"/i
      )
    })
  })
})
