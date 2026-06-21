/**
 * Unit tests for the publish dispatcher matrix.
 *
 * We exercise each dispatcher directly (skipping the top-level `publish()`
 * resolver) so the tests do not require a fully-initialized AppManager.
 */

import { describe, it, expect, vi } from 'vitest'

// fetch is on globalThis in Node 18+ — we override it per test
const realFetch = globalThis.fetch

import { dispatch as dispatchHttp } from '../../../src/main/store/publish/dispatchers/http-registry'
import { dispatch as dispatchLocal } from '../../../src/main/store/publish/dispatchers/local-dhpkg'
import type { AppSpec } from '../../../src/main/apps/spec/schema'

function fakeSpec(): AppSpec {
  return {
    spec_version: '1',
    name: 'publish-test',
    version: '0.1.0',
    author: 'tester',
    description: 'unit-test',
    type: 'skill',
    skill_files: { 'SKILL.md': '# hi\n' },
    store: { slug: 'tester/publish-test' },
  } as AppSpec
}

describe('publish/http-registry', () => {
  it('refuses to publish when the token is the deploy-time placeholder', async () => {
    const res = await dispatchHttp(
      fakeSpec(),
      { 'SKILL.md': '# hi\n' },
      { registryId: 'official', registryUrl: 'http://example.test' },
      { token: 'REPLACE_AT_DEPLOY_TIME' },
    )
    expect(res.status).toBe('error')
    expect(res.target).toBe('http-registry')
    expect(res.details).toMatch(/not configured/i)
  })

  it('posts spec.yaml + file parts in the DHP v2 multipart format and surfaces the verdict on success', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ slug: 'tester/publish-test', version: '0.1.0', verdict: 'approved', comment: 'looks good' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    ;(globalThis as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch

    try {
      const res = await dispatchHttp(
        fakeSpec(),
        { 'SKILL.md': '# hi\n' },
        { registryId: 'official', registryUrl: 'http://example.test' },
        { token: 'secret' },
      )
      expect(res.status).toBe('success')
      expect(res.verdict).toBe('approved')
      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [calledUrl, init] = mockFetch.mock.calls[0]
      expect(calledUrl).toBe('http://example.test/apps')
      expect((init as RequestInit).method).toBe('POST')
      expect((init as RequestInit).headers).toEqual(expect.objectContaining({ Authorization: 'Bearer secret' }))

      // Regression guard: the server's handlePublish does r.FormFile("spec"),
      // so the dispatcher MUST send a part literally named "spec" (the YAML
      // serialization of the spec), plus each auxiliary file under its own
      // relative-path form field name. The previous protocol sent slug+version
      // text fields and a single "dhpkg" zip — that produced a silent HTTP 400
      // "missing 'spec' file part" in production.
      const body = (init as RequestInit).body as FormData
      expect(body).toBeInstanceOf(FormData)
      const specPart = body.get('spec')
      expect(specPart).toBeInstanceOf(Blob)
      const specText = await (specPart as Blob).text()
      expect(specText).toMatch(/name:\s*publish-test/)
      expect(specText).toMatch(/type:\s*skill/)
      const skillPart = body.get('SKILL.md')
      expect(skillPart).toBeInstanceOf(Blob)
      expect(await (skillPart as Blob).text()).toBe('# hi\n')
      expect(body.get('dhpkg')).toBeNull()
      expect(body.get('slug')).toBeNull()
      expect(body.get('version')).toBeNull()

      // Regression guard: server's spec.go declares `SkillFiles []string` so
      // the wire-format spec.yaml MUST list skill files by NAME only — never
      // dump the inline `Record<path, content>` map (which would emit nested
      // YAML mappings and trigger "cannot unmarshal !!map into []string").
      // The actual content is delivered through the multipart SKILL.md part.
      expect(specText).toMatch(/skill_files:\s*\n\s*-\s*SKILL\.md/)
      expect(specText).not.toMatch(/SKILL\.md:\s*[|>]/)
    } finally {
      ;(globalThis as { fetch: typeof fetch }).fetch = realFetch
    }
  })

  it('returns error when the registry responds non-2xx', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ comment: 'auth required' }), { status: 401 }),
    )
    ;(globalThis as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch

    try {
      const res = await dispatchHttp(
        fakeSpec(),
        {},
        { registryId: 'official', registryUrl: 'http://example.test' },
        { token: 'secret' },
      )
      expect(res.status).toBe('error')
      expect(res.details).toMatch(/HTTP 401/)
    } finally {
      ;(globalThis as { fetch: typeof fetch }).fetch = realFetch
    }
  })
})

describe('publish/local-dhpkg', () => {
  it('returns cancelled when the save dialog is dismissed', async () => {
    vi.resetModules()
    vi.doMock('electron', () => ({
      dialog: { showSaveDialog: vi.fn().mockResolvedValue({ canceled: true, filePath: undefined }) },
    }))

    const { dispatch } = await import('../../../src/main/store/publish/dispatchers/local-dhpkg')
    const res = await dispatch(
      fakeSpec(),
      { 'SKILL.md': '# hi\n' },
      { registryId: 'official', registryUrl: null },
      {},
    )
    expect(res.status).toBe('cancelled')
    expect(res.target).toBe('local-dhpkg')

    vi.doUnmock('electron')
    vi.resetModules()
    // Touch unused import for tree-shaking sanity
    void dispatchLocal
  })
})
