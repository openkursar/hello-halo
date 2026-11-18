import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import * as tar from 'tar-stream'
const mocks = vi.hoisted(() => ({ metadata: vi.fn() }))
vi.mock('../../../src/main/services/external-runtime/transfer', () => ({
  readMetadataResponse: async (url: string, signal: AbortSignal) => ({ text: await mocks.metadata(url, signal), url })
}))
import { fetchCodexRelease } from '../../../src/main/services/external-runtime/providers/codex/releases'
import { archiveEntryPath, materializeCodex } from '../../../src/main/services/external-runtime/providers/codex/archive'
import { RECOMMENDED_INTEGRITY, RECOMMENDED_VERSION, optionalComponents, requiredComponents } from '../../../src/main/services/external-runtime/providers/codex/policy'
import { probeCodex } from '../../../src/main/services/external-runtime/providers/codex/protocol'
import { resolveCodexCandidate } from '../../../src/main/services/external-runtime/providers/codex/local'
import type { RuntimeArtifact, RuntimeProbeRunner } from '../../../src/main/services/external-runtime/provider'

const source = { id: 'test', name: 'Test', baseUrl: 'https://mirror.test/npm/prefix' }
const directories: string[] = []
afterEach(async () => { vi.resetAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function temporary() { const path = await mkdtemp(join(tmpdir(), 'halo-codex-test-')); directories.push(path); return path }
function metadata(version = RECOMMENDED_VERSION, integrity = RECOMMENDED_INTEGRITY['darwin-arm64']) {
  mocks.metadata.mockImplementation(async (url: string) => JSON.stringify(url.endsWith('darwin-arm64') ? { name: '@openai/codex', version: `${version}-darwin-arm64`, os: ['darwin'], cpu: ['arm64'], dist: { integrity, tarball: 'https://cdn.test/codex.tgz' } } : { name: '@openai/codex', version, optionalDependencies: { '@openai/codex-darwin-arm64': `npm:@openai/codex@${version}-darwin-arm64` } }))
}
async function archive(entries: Array<{ name: string; content?: string; type?: string; linkname?: string }>) {
  const directory = await temporary()
  const pack = tar.pack()
  const chunks: Buffer[] = []
  const done = new Promise<Buffer>((resolve, reject) => { pack.on('data', chunk => { if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk)); else reject(new Error('Invalid archive chunk')) }); pack.on('end', () => resolve(Buffer.concat(chunks))); pack.on('error', reject) })
  for (const entry of entries) pack.entry({ name: entry.name, type: entry.type as 'file', linkname: entry.linkname }, entry.content || '')
  pack.finalize()
  const bytes = gzipSync(await done)
  const path = join(directory, 'payload.tgz')
  await writeFile(path, bytes)
  const artifact = { platform: 'darwin-arm64', payloadVersion: '0.128.0-darwin-arm64', integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } as RuntimeArtifact
  const output = join(directory, 'output'); await mkdir(output)
  return { artifact, path, output }
}
const validEntries = () => [{ name: 'package/package.json', content: JSON.stringify({ name: '@openai/codex', version: '0.128.0-darwin-arm64', os: ['darwin'], cpu: ['arm64'] }) }, ...requiredComponents('darwin-arm64').map(path => ({ name: `package/${path}`, content: 'native fixture' }))]

describe('Codex registry contract', () => {
  it('uses actual package metadata, exact aliases, strong official pin and prefixed registry', async () => {
    metadata()
    const result = await fetchCodexRelease(source, RECOMMENDED_VERSION, 'darwin-arm64', new AbortController().signal)
    expect(result.integrity).toBe(RECOMMENDED_INTEGRITY['darwin-arm64'])
    expect(result.checksum).toHaveLength(128)
    expect(mocks.metadata.mock.calls.map(call => call[0])).toEqual([`https://mirror.test/npm/prefix/@openai%2Fcodex/${RECOMMENDED_VERSION}`, `https://mirror.test/npm/prefix/@openai%2Fcodex/${RECOMMENDED_VERSION}-darwin-arm64`])
  })
  it('resolves a source tag, without inventing stable or enumerating packuments', async () => {
    metadata('0.129.0', `sha512-${Buffer.alloc(64, 3).toString('base64')}`)
    expect(await fetchCodexRelease(source, 'stable', 'darwin-arm64', new AbortController().signal)).toMatchObject({ version: '0.129.0', recommended: false })
    expect(mocks.metadata.mock.calls[0][0]).toContain('/stable')
  })
  it('rejects a mirror changing recommended bytes', async () => {
    metadata(RECOMMENDED_VERSION, `sha512-${Buffer.alloc(64, 3).toString('base64')}`)
    await expect(fetchCodexRelease(source, RECOMMENDED_VERSION, 'darwin-arm64', new AbortController().signal)).rejects.toMatchObject({ code: 'checksum-mismatch' })
  })
})

describe('Codex strict archive materialization', () => {
  it.each(['package/../escape', '/package/package.json', 'package/vendor/../../escape', 'package\\vendor\\x', 'package/C:evil', 'package/package.json.map', 'package/vendor/wrong/codex/codex', 'package//package.json'])('rejects unsafe or unexpected path %s', path => {
    expect(() => archiveEntryPath(path, 'darwin-arm64')).toThrow()
  })
  it('accepts the bundled Linux sandbox helper only on Linux', () => {
    const [helper] = optionalComponents('linux-x64')
    expect(archiveEntryPath(`package/${helper}`, 'linux-x64')).toBe(helper)
    expect(archiveEntryPath('package/vendor/x86_64-unknown-linux-musl/codex-resources/', 'linux-x64')).toBe('vendor/x86_64-unknown-linux-musl/codex-resources')
    expect(() => archiveEntryPath('package/vendor/x86_64-unknown-linux-musl/codex-resources/other', 'linux-x64')).toThrow()
    expect(() => archiveEntryPath('package/vendor/aarch64-apple-darwin/codex-resources/bwrap', 'darwin-arm64')).toThrow()
  })
  it('retains full helpers and hashes every retained component', async () => {
    const fixture = await archive(validEntries())
    const result = await materializeCodex(fixture.artifact, fixture.path, fixture.output, new AbortController().signal)
    expect(result.components).toHaveLength(3)
    expect(result.components.every(component => component.checksum.length === 64)).toBe(true)
    expect(await readFile(join(fixture.output, result.executable), 'utf8')).toBe('native fixture')
  })
  it.each(['symlink', 'link'])('rejects %s entries', async type => {
    const fixture = await archive([...validEntries(), { name: 'package/LICENSE', type, linkname: '../../escape' }])
    await expect(materializeCodex(fixture.artifact, fixture.path, fixture.output, new AbortController().signal)).rejects.toThrow()
  })
  it('rejects duplicate/case-colliding paths and missing helpers', async () => {
    for (const entries of [[...validEntries(), validEntries()[0]], validEntries().slice(0, 2)]) {
      const fixture = await archive(entries)
      await expect(materializeCodex(fixture.artifact, fixture.path, fixture.output, new AbortController().signal)).rejects.toThrow()
    }
  })
  it('checks the complete compressed archive before writing files', async () => {
    const fixture = await archive(validEntries())
    fixture.artifact.integrity = `sha512-${Buffer.alloc(64).toString('base64')}`
    await expect(materializeCodex(fixture.artifact, fixture.path, fixture.output, new AbortController().signal)).rejects.toMatchObject({ code: 'checksum-mismatch' })
    await expect(readFile(join(fixture.output, 'package.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('Codex bounded runner protocol adapter', () => {
  it('requires initialize/initialized and non-model config/thread interfaces, not version only', async () => {
    const calls: unknown[] = []
    const runner = Object.assign(async (process: any) => {
      calls.push(process)
      if (process.args[0] === '--version') return 'codex-cli 0.128.0\n'
      const sent: string[] = []
      expect(process.env.CODEX_HOME).toBe('/isolated')
      expect(process.onLine(JSON.stringify({ id: 1, result: { userAgent: 'codex' } }), (s: string) => sent.push(s))).toBe(false)
      expect(JSON.parse(sent[0]).method).toBe('initialized')
      process.onLine(JSON.stringify({ id: 2, result: { config: {} } }), (s: string) => sent.push(s))
      expect(process.onLine(JSON.stringify({ id: 3, result: { data: [] } }), () => {})).toBe(true)
      expect(sent.join('')).not.toMatch(/turn\/start|thread\/start|login/)
      return 'ready'
    }, { directory: '/isolated', reportVersion: vi.fn() }) as RuntimeProbeRunner
    expect(await probeCodex({} as any, runner)).toBe('0.128.0')
    expect(calls).toHaveLength(2)
  })
})

it.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')('stamps symlink target and required helper changes without executing JS launcher', async () => {
  const directory = await temporary()
  for (const component of requiredComponents('darwin-arm64')) { const path = join(directory, component); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, Buffer.from('cffaedfe', 'hex'), { mode: 0o755 }) }
  const link = join(directory, 'codex'); await symlink(join(directory, requiredComponents('darwin-arm64')[0]), link)
  const first = await resolveCodexCandidate(link)
  expect(first.path).toBe(link)
  await writeFile(join(directory, requiredComponents('darwin-arm64')[1]), Buffer.from('cffaedfe00', 'hex'), { mode: 0o755 })
  expect((await resolveCodexCandidate(link)).stamp).not.toBe(first.stamp)
})
