/**
 * Unit tests for HaloAdapter
 *
 * Focused regression coverage for the index schema's forgiveness rules.
 * We mock global fetch (and proxy-fetch) to stand in for a registry server
 * so the adapter parsing pipeline runs without I/O.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

// Stub proxy-fetch so fetchWithTimeout falls through to the global fetch mock
// without touching electron.session (not available in Node test environment).
vi.mock('../../../src/main/services/proxy-fetch', () => ({
  proxyFetch: (url: string, init?: RequestInit) => fetch(url, init),
}))

import { HaloAdapter } from '../../../src/main/store/adapters/halo.adapter'
import type { RegistrySource } from '../../../src/shared/store/store-types'

const MOCK_SOURCE: RegistrySource = {
  id: 'halo-local',
  name: 'Halo Local Test',
  url: 'http://example.test',
  enabled: true,
  sourceType: 'halo',
}

const realFetch = globalThis.fetch

function envelope(apps: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    version: 1,
    generated_at: '2026-01-01T00:00:00Z',
    source: 'test',
    apps,
  }
}

function baseEntry(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'alice/hello',
    name: 'Hello',
    version: '1.0.0',
    author: 'alice',
    description: 'A polite greeter',
    type: 'skill',
    path: 'apps/alice/hello/1.0.0',
    ...extra,
  }
}

/**
 * Build a fetch mock that maps URL → response body.
 *
 * String values starting with `__YAML__:` are served as raw YAML;
 * `__TEXT__:` as raw text/plain; anything else is JSON-encoded.
 * This lets one helper drive both the index endpoints (JSON) and the
 * spec.yaml / file content endpoints (text-flavored) in the same test.
 */
function mockFetchMap(map: Record<string, unknown>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (map[url] === undefined) {
      return new Response('not found', { status: 404 })
    }
    const v = map[url]
    if (typeof v === 'string' && v.startsWith('__YAML__:')) {
      return new Response(v.slice('__YAML__:'.length), {
        status: 200,
        headers: { 'Content-Type': 'application/x-yaml' },
      })
    }
    if (typeof v === 'string' && v.startsWith('__TEXT__:')) {
      return new Response(v.slice('__TEXT__:'.length), {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }
    return new Response(JSON.stringify(v), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

describe('HaloAdapter', () => {
  beforeEach(() => {
    ;(globalThis as { fetch: typeof fetch }).fetch = realFetch
  })

  afterEach(() => {
    ;(globalThis as { fetch: typeof fetch }).fetch = realFetch
    vi.restoreAllMocks()
  })

  it('accepts split index responses that omit the optional format field (legacy server)', async () => {
    // A legacy server doesn't write `format` into its index entries. The Halo
    // adapter must tolerate that and default format to 'bundle' rather than
    // failing schema validation and silently falling back to index.json.
    const indexEntry = baseEntry() // no `format` field
    ;(globalThis as { fetch: typeof fetch }).fetch = mockFetchMap({
      'http://example.test/digital-humans.json': envelope([]),
      'http://example.test/skills.json': envelope([indexEntry]),
      'http://example.test/mcps.json': envelope([]),
    })

    const adapter = new HaloAdapter()
    const index = await adapter.fetchIndex(MOCK_SOURCE)

    expect(index.apps).toHaveLength(1)
    expect(index.apps[0].slug).toBe('alice/hello')
    expect(index.apps[0].format).toBe('bundle')
  })

  it('accepts split index responses that include format:bundle (current server)', async () => {
    const indexEntry = baseEntry({ format: 'bundle' })
    ;(globalThis as { fetch: typeof fetch }).fetch = mockFetchMap({
      'http://example.test/digital-humans.json': envelope([]),
      'http://example.test/skills.json': envelope([indexEntry]),
      'http://example.test/mcps.json': envelope([]),
    })

    const adapter = new HaloAdapter()
    const index = await adapter.fetchIndex(MOCK_SOURCE)

    expect(index.apps).toHaveLength(1)
    expect(index.apps[0].format).toBe('bundle')
  })

  it('fetchSpec materializes skill_files (wire string[] -> local Record<name,content>)', async () => {
    // Server-side spec.yaml carries `skill_files` as a string[] of file names;
    // the actual content travels as separate multipart uploads. The adapter
    // must reconstruct the local Record<name, content> shape before returning,
    // otherwise SkillSpec validation (which expects an object) blows up and
    // every skill install from the registry fails.
    const specYaml = [
      'spec_version: "1"',
      'name: hello',
      'version: "1.0.0"',
      'author: alice',
      'description: A polite skill',
      'type: skill',
      'store:',
      '  slug: hello-skill',
      'skill_files:',
      '  - SKILL.md',
      '  - references/guide.md',
      '',
    ].join('\n')

    ;(globalThis as { fetch: typeof fetch }).fetch = mockFetchMap({
      'http://example.test/apps/hello-skill/1.0.0/spec.yaml': '__YAML__:' + specYaml,
      'http://example.test/apps/hello-skill/1.0.0/files/SKILL.md': '__TEXT__:# Hello SKILL',
      'http://example.test/apps/hello-skill/1.0.0/files/references/guide.md': '__TEXT__:Guide body',
    }) as unknown as typeof fetch

    const adapter = new HaloAdapter()
    const entry = {
      slug: 'hello-skill',
      name: 'hello',
      version: '1.0.0',
      author: 'alice',
      description: 'A polite skill',
      type: 'skill',
      format: 'bundle',
      path: 'apps/hello-skill/1.0.0',
      category: 'other',
      tags: [],
    } as unknown as Parameters<typeof adapter.fetchSpec>[1]

    const spec = await adapter.fetchSpec(MOCK_SOURCE, entry)

    expect(spec.type).toBe('skill')
    // Cast: the discriminated union narrows to SkillSpec here.
    const skillFiles = (spec as { skill_files?: Record<string, string> }).skill_files
    expect(skillFiles).toBeDefined()
    expect(skillFiles).toEqual({
      'SKILL.md': '# Hello SKILL',
      'references/guide.md': 'Guide body',
    })
  })

  it('rejects an entry whose path attempts directory traversal', async () => {
    // The index comes from a remote mirror; a `..` in `path` would let a
    // compromised registry pull spec.yaml from outside its own subtree.
    ;(globalThis as { fetch: typeof fetch }).fetch = mockFetchMap({})
    const adapter = new HaloAdapter()
    const entry = baseEntry({ path: '../../../../etc' }) as unknown as Parameters<typeof adapter.fetchSpec>[1]
    await expect(adapter.fetchSpec(MOCK_SOURCE, entry)).rejects.toThrow(/Unsafe registry path/)
  })

  it('rejects a percent-encoded traversal in an entry path', async () => {
    ;(globalThis as { fetch: typeof fetch }).fetch = mockFetchMap({})
    const adapter = new HaloAdapter()
    const entry = baseEntry({ path: 'apps/%2e%2e/%2e%2e/secret' }) as unknown as Parameters<typeof adapter.fetchSpec>[1]
    await expect(adapter.fetchSpec(MOCK_SOURCE, entry)).rejects.toThrow(/Unsafe registry path/)
  })

  it('rejects entries with an unknown format literal', async () => {
    // The forgiveness for missing-format must NOT extend to other values —
    // unknown packaging would let bogus entries slip into the store.
    const indexEntry = baseEntry({ format: 'tarball' })
    ;(globalThis as { fetch: typeof fetch }).fetch = mockFetchMap({
      'http://example.test/digital-humans.json': envelope([]),
      'http://example.test/skills.json': envelope([indexEntry]),
      'http://example.test/mcps.json': envelope([]),
      // Legacy fallback that the adapter will try — make it 404 so the error
      // surfaces explicitly instead of being swallowed.
      'http://example.test/index.json': envelope([indexEntry]),
    })

    const adapter = new HaloAdapter()
    await expect(adapter.fetchIndex(MOCK_SOURCE)).rejects.toThrow(/format/)
  })
})
