import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { startRuntimeRegistry } from '../../e2e/fixtures/runtime-registry'

it('serves the exact artifact prefix once, then resumes the remaining bytes without changing integrity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'registry-prefix-'))
  const previous = process.env.HALO_ACCEPTANCE_CLAUDE_PROVENANCE
  const bytes = Buffer.from(Array.from({ length: 8192 }, (_, index) => index % 251))
  const executable = join(directory, 'claude')
  const receipt = join(directory, 'receipt.json')
  await writeFile(executable, bytes)
  await writeFile(receipt, JSON.stringify({ executable, version: '2.1.310', platform: process.platform, arch: process.arch, sha256: createHash('sha256').update(bytes).digest('hex') }))
  process.env.HALO_ACCEPTANCE_CLAUDE_PROVENANCE = receipt
  const registry = await startRuntimeRegistry('anthropic', { pausePrefixBytes: 1024 })
  try {
    registry.pause()
    const response = await fetch(`${registry.baseUrl}/claude`)
    expect(response.headers.get('content-length')).toBe(String(bytes.length))
    const reader = response.body!.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    while (received < 1024) {
      const next = await reader.read()
      expect(next.done).toBe(false)
      chunks.push(next.value!)
      received += next.value!.length
    }
    expect(received).toBe(1024)
    expect(Buffer.concat(chunks)).toEqual(bytes.subarray(0, 1024))
    registry.resume()
    while (true) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(next.value)
    }
    expect(Buffer.concat(chunks)).toEqual(bytes)
    await expect(startRuntimeRegistry('anthropic', { pausePrefixBytes: 262145 })).rejects.toThrow('256 KiB')
  } finally {
    await registry.close()
    if (previous === undefined) delete process.env.HALO_ACCEPTANCE_CLAUDE_PROVENANCE
    else process.env.HALO_ACCEPTANCE_CLAUDE_PROVENANCE = previous
    await rm(directory, { recursive: true, force: true })
  }
})
