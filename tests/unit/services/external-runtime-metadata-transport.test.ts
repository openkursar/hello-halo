import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('../../../src/main/services/proxy-fetch', () => ({ proxyFetch: mocks.fetch }))
import { readMetadata, readMetadataResponse } from '../../../src/main/services/external-runtime/transfer'
import { claudeCodeProvider } from '../../../src/main/services/external-runtime/providers/claude-code'
import { fetchCodexRelease } from '../../../src/main/services/external-runtime/providers/codex/releases'
const source = { id: 'custom', name: 'Mirror', baseUrl: 'http://mirror.invalid/npm' }
const signal = () => new AbortController().signal
beforeEach(() => { mocks.fetch.mockReset() })
function redirect(url: string) { return new Response(null, { status: 302, headers: { location: url } }) }
function metadata(url: string, artifact = 'http://mirror.invalid/archive.tgz') {
  if (url.includes('manifest.json')) return JSON.stringify({ version: '2.1.310', platforms: { 'darwin-arm64': { checksum: 'a'.repeat(64) } } })
  if (url.endsWith('/latest') && !url.includes('@openai')) return '2.1.310'
  const payload = url.includes('0.129.0-darwin-arm64')
  return JSON.stringify(payload ? { name: '@openai/codex', version: '0.129.0-darwin-arm64', os: ['darwin'], cpu: ['arm64'], dist: { integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`, tarball: artifact } } : { name: '@openai/codex', version: '0.129.0', optionalDependencies: { '@openai/codex-darwin-arm64': 'npm:@openai/codex@0.129.0-darwin-arm64' } })
}
describe('metadata effective transport security', () => {
  it('preserves the validated final URL while retaining the legacy string facade', async () => {
    mocks.fetch.mockImplementation(async (url: string) => url.startsWith('http:') ? redirect(url.replace('http:', 'https:')) : new Response('metadata'))
    await expect(readMetadataResponse('http://mirror.invalid/manifest', signal())).resolves.toEqual({ text: 'metadata', url: 'https://mirror.invalid/manifest' })
    await expect(readMetadata('http://mirror.invalid/manifest', signal())).resolves.toBe('metadata')
  })
  it.each(['0.129.0', 'latest'])('rejects HTTP artifacts after upgraded Codex %s metadata', async version => {
    mocks.fetch.mockImplementation(async (url: string) => url.startsWith('http:') ? redirect(url.replace('http:', 'https:')) : new Response(metadata(url)))
    await expect(fetchCodexRelease(source, version, 'darwin-arm64', signal())).rejects.toMatchObject({ code: 'invalid-source' })
  })
  it('remembers a secure tag response even when later payload metadata is HTTP', async () => {
    mocks.fetch.mockImplementation(async (url: string) => url.startsWith('http:') && url.endsWith('/latest') ? redirect(url.replace('http:', 'https:')) : new Response(metadata(url)))
    await expect(fetchCodexRelease(source, 'latest', 'darwin-arm64', signal())).rejects.toMatchObject({ code: 'invalid-source' })
  })
  it.each(['2.1.310', 'latest'])('rejects HTTP CC artifacts after upgraded %s metadata', async version => {
    mocks.fetch.mockImplementation(async (url: string) => url.startsWith('http:') ? redirect(url.replace('http:', 'https:')) : new Response(metadata(url)))
    await expect(claudeCodeProvider.fetchRelease(source, version, 'darwin-arm64', signal())).rejects.toMatchObject({ code: 'invalid-source' })
  })
  it('allows HTTP intranet chains and HTTPS CDN artifacts after metadata upgrade', async () => {
    mocks.fetch.mockImplementation(async (url: string) => new Response(metadata(url)))
    await expect(fetchCodexRelease(source, '0.129.0', 'darwin-arm64', signal())).resolves.toMatchObject({ url: 'http://mirror.invalid/archive.tgz' })
    await expect(claudeCodeProvider.fetchRelease(source, '2.1.310', 'darwin-arm64', signal())).resolves.toMatchObject({ version: '2.1.310' })
    mocks.fetch.mockImplementation(async (url: string) => url.startsWith('http:') ? redirect(url.replace('http:', 'https:')) : new Response(metadata(url, 'https://cdn.invalid/archive.tgz')))
    await expect(fetchCodexRelease(source, '0.129.0', 'darwin-arm64', signal())).resolves.toMatchObject({ url: 'https://cdn.invalid/archive.tgz' })
  })
})
