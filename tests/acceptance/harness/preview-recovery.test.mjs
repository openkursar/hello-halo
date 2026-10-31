import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { unzipSync, strFromU8 } from 'fflate'
import { DOMParser } from '@xmldom/xmldom'

const directory = await mkdtemp(join(tmpdir(), 'acceptance-preview-recovery-'))
after(() => rm(directory, { recursive: true, force: true }))
const source = new URL('../../e2e/fixtures/acceptance-preview-recovery.ts', import.meta.url)
const compiled = join(directory, 'fixture.mjs')
await build({ entryPoints: [fileURLToPath(source)], outfile: compiled, bundle: true, platform: 'node', format: 'esm', define: { 'import.meta.url': JSON.stringify(source.href) }, logLevel: 'silent' })
const { damagedPreviewDocument } = await import(pathToFileURL(compiled).href)

test('the recovery sample starts as a readable Word package and its truncated copy is rejected by an independent ZIP reader', async () => {
  const marker = 'Reference & quantity <42>'
  const { valid, damaged } = await damagedPreviewDocument(marker)
  const files = unzipSync(valid.bytes)
  const fail = message => { throw new Error(`Invalid fixture XML: ${message}`) }
  const parser = new DOMParser({ errorHandler: { warning: fail, error: fail, fatalError: fail } })
  const document = parser.parseFromString(strFromU8(files['word/document.xml']), 'application/xml')
  assert.deepEqual(Array.from(document.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 't')).map(node => node.textContent), [
    'Offline knowledge reference', marker, 'Quantity: 87261345.25', 'Review: Alpha & Beta < Gamma',
  ])
  assert.ok(files['[Content_Types].xml'])
  assert.ok(files['_rels/.rels'])
  assert.equal(damaged.name, 'truncated-reference.docx')
  assert.equal(damaged.bytes.length, Math.floor(valid.bytes.length / 2))
  assert.deepEqual(damaged.bytes, valid.bytes.subarray(0, damaged.bytes.length))
  assert.throws(() => unzipSync(damaged.bytes))
})
