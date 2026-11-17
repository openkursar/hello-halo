import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'halo-runtime-registry-'))
after(() => fs.rm(directory, { recursive: true, force: true }))
const compiled = path.join(directory, 'registry.mjs')
await build({ entryPoints: [fileURLToPath(new URL('../../e2e/fixtures/runtime-registry.ts', import.meta.url))], outfile: compiled, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
const { startRuntimeRegistry } = await import(pathToFileURL(compiled).href)

test('the local registry serves identical fixture bytes, supports outage and records requests', async context => {
  const executable = path.join(directory, 'claude')
  const receipt = path.join(directory, 'receipt.json')
  const bytes = Buffer.from('inert registry unit fixture; never executed')
  await fs.writeFile(executable, bytes)
  await fs.writeFile(receipt, JSON.stringify({ executable, platform: process.platform, arch: process.arch, version: '2.1.63', sha256: createHash('sha256').update(bytes).digest('hex') }))
  const previous = process.env.HALO_ACCEPTANCE_CLAUDE_PROVENANCE
  process.env.HALO_ACCEPTANCE_CLAUDE_PROVENANCE = receipt
  context.after(() => { if (previous === undefined) delete process.env.HALO_ACCEPTANCE_CLAUDE_PROVENANCE; else process.env.HALO_ACCEPTANCE_CLAUDE_PROVENANCE = previous })
  const registry = await startRuntimeRegistry('anthropic')
  try {
    const metadata = await fetch(`${registry.baseUrl}/2.1.63/manifest.json`).then(response => response.json())
    assert.equal(metadata.version, '2.1.63')
    assert.deepEqual(Buffer.from(await fetch(`${registry.baseUrl}/2.1.63/darwin-arm64/claude`).then(response => response.arrayBuffer())), bytes)
    registry.setOnline(false)
    assert.equal((await fetch(`${registry.baseUrl}/2.1.63/manifest.json`)).status, 503)
    assert.equal(registry.requests.length, 3)
  } finally { await registry.close() }
})
