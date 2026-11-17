import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { materializeCodex, archiveEntryPath } from '../../../src/main/services/external-runtime/providers/codex/archive'
import { requiredComponents } from '../../../src/main/services/external-runtime/providers/codex/policy'
import type { RuntimeArtifact } from '../../../src/main/services/external-runtime/provider'

function header(name: string, size = 0, type = '0') {
  const buffer = Buffer.alloc(512)
  buffer.write(name, 0, 100)
  buffer.write('0000755\0', 100)
  buffer.write('0000000\0', 108)
  buffer.write('0000000\0', 116)
  buffer.write(size.toString(8).padStart(11, '0') + '\0', 124)
  buffer.write('00000000000\0', 136)
  buffer.fill(32, 148, 156)
  buffer.write(type, 156)
  buffer.write('ustar\0', 257)
  let checksum = 0
  for (const byte of buffer) checksum += byte
  buffer.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148)
  return buffer
}
function entry(name: string, content = '') {
  const bytes = Buffer.from(content)
  return Buffer.concat([header(name, bytes.length), bytes, Buffer.alloc((512 - bytes.length % 512) % 512)])
}
async function fixture(name: string, raw: Buffer, compressed = true) {
  const root = join(globalThis.__HALO_TEST_DIR__, name)
  const output = join(root, 'output')
  await mkdir(output, { recursive: true })
  const bytes = compressed ? gzipSync(raw) : raw
  const path = join(root, 'payload.tgz')
  await writeFile(path, bytes)
  const artifact = { platform: 'darwin-arm64', payloadVersion: '0.128.0-darwin-arm64', integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } as RuntimeArtifact
  return { root, output, path, artifact }
}
const valid = () => Buffer.concat([
  entry('package/package.json', JSON.stringify({ name: '@openai/codex', version: '0.128.0-darwin-arm64', os: ['darwin'], cpu: ['arm64'] })),
  ...requiredComponents('darwin-arm64').map(path => entry(`package/${path}`, 'fixture'))
])

describe('Codex archive hostile input boundaries', () => {
  it('rejects a header declaring more than the per-file bound before allocating payload', async () => {
    const value = await fixture('oversized-header', header('package/package.json', 512 * 1024 * 1024 + 1))
    await expect(materializeCodex(value.artifact, value.path, value.output, new AbortController().signal)).rejects.toThrow()
  })
  it('rejects a truncated declared file even when compressed bytes have matching integrity', async () => {
    const value = await fixture('truncated-entry', Buffer.concat([header('package/package.json', 1000), Buffer.from('{}')]))
    await expect(materializeCodex(value.artifact, value.path, value.output, new AbortController().signal)).rejects.toThrow()
  })
  it('rejects directory-only header flooding without retaining files', async () => {
    const value = await fixture('too-many-entries', Buffer.concat(Array.from({ length: 65 }, () => header('package/', 0, '5'))))
    await expect(materializeCodex(value.artifact, value.path, value.output, new AbortController().signal)).rejects.toThrow()
  })
  it('rejects a case collision rather than replacing a previously written file', async () => {
    const value = await fixture('case-collision', Buffer.concat([valid(), entry('package/license', 'one'), entry('package/LICENSE', 'two'), Buffer.alloc(1024)]))
    await expect(materializeCodex(value.artifact, value.path, value.output, new AbortController().signal)).rejects.toThrow()
  })
  it.each(['package/vendor/x/codex/codex.exe:payload', 'package/C:/payload', 'package/\\\\server\\share', 'package/vendor/../escape'])('rejects Windows ADS, drive, UNC or traversal path %s', path => {
    expect(() => archiveEntryPath(path, 'win32-x64')).toThrow()
  })
  it('rejects a malformed gzip with a correct compressed-byte integrity', async () => {
    const value = await fixture('invalid-gzip', Buffer.from('not gzip'), false)
    await expect(materializeCodex(value.artifact, value.path, value.output, new AbortController().signal)).rejects.toThrow()
  })
  it('honors pre-cancellation before retaining any executable', async () => {
    const value = await fixture('cancelled', Buffer.concat([valid(), Buffer.alloc(1024)]))
    const controller = new AbortController()
    controller.abort()
    await expect(materializeCodex(value.artifact, value.path, value.output, controller.signal)).rejects.toThrow()
    await expect(readFile(join(value.output, requiredComponents('darwin-arm64')[0]))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

it.each(['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'] as const)('declares complete %s component layout without claiming cross-platform execution', platform => {
  const components = requiredComponents(platform)
  expect(new Set(components).size).toBe(components.length)
  expect(components.some(path => path.includes('/path/rg'))).toBe(true)
  expect(components[0]).toMatch(/\/codex\/codex(?:\.exe)?$/)
  for (const path of components) expect(archiveEntryPath(`package/${path}`, platform)).toBe(path)
  if (platform === 'win32-x64') {
    expect(components).toHaveLength(4)
    expect(components.some(path => path.endsWith('/codex-windows-sandbox-setup.exe'))).toBe(true)
    expect(components.some(path => path.endsWith('/codex-command-runner.exe'))).toBe(true)
  } else expect(components).toHaveLength(2)
})
