import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const { PNG } = createRequire(import.meta.url)('pngjs')
const source = new URL('../../e2e/fixtures/acceptance-preview-formats.ts', import.meta.url)
const directory = await mkdtemp(join(tmpdir(), 'acceptance-preview-pattern-'))
after(() => rm(directory, { recursive: true, force: true }))
const compiled = join(directory, 'fixture.mjs')
await build({ entryPoints: [fileURLToPath(source)], outfile: compiled, bundle: true, platform: 'node', format: 'esm', define: { 'import.meta.url': JSON.stringify(source.href) }, logLevel: 'silent' })
const { cropPreviewFrame, decodePreviewPattern, previewDocument, previewImageSamples } = await import(pathToFileURL(compiled).href)
const palette = [[224, 24, 48], [16, 144, 80], [24, 96, 224], [232, 184, 16]]
const pattern = Array.from({ length: 64 }, (_, index) => (index * 7 + Math.floor(index / 8)) % 4)

test('crops a nonzero CSS origin from full-frame pixels at standard, fractional and doubled scale', () => {
  const viewport = { width: 400, height: 240 }
  const bounds = { x: 120, y: 50, width: 100, height: 60 }
  for (const scale of [1, 1.5, 2]) {
    const image = { width: viewport.width * scale, height: viewport.height * scale, data: Buffer.alloc(viewport.width * viewport.height * scale * scale * 4, 255) }
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      const at = (y * image.width + x) * 4
      image.data[at] = Math.floor(x / scale) % 256
      image.data[at + 1] = Math.floor(y / scale) % 256
      image.data[at + 2] = (Math.floor(x / scale) + Math.floor(y / scale)) % 256
    }
    const cropped = cropPreviewFrame(PNG.sync.write(image), viewport, bounds)
    assert.deepEqual(cropped.pixels, { left: 120 * scale, top: 50 * scale, width: 100 * scale, height: 60 * scale })
    const output = PNG.sync.read(cropped.bytes)
    assert.equal(output.width, 100 * scale)
    assert.equal(output.height, 60 * scale)
    for (let y = 0; y < output.height; y++) {
      const start = ((50 * scale + y) * image.width + 120 * scale) * 4
      assert.deepEqual(output.data.subarray(y * output.width * 4, (y + 1) * output.width * 4), image.data.subarray(start, start + output.width * 4))
    }
  }
})

test('a crop with inconsistent viewport proportions or outside bounds is rejected', () => {
  const bytes = PNG.sync.write({ width: 400, height: 240, data: Buffer.alloc(400 * 240 * 4, 255) })
  assert.throws(() => cropPreviewFrame(bytes, { width: 800, height: 240 }, { x: 0, y: 0, width: 100, height: 60 }), /proportions/)
  assert.throws(() => cropPreviewFrame(bytes, { width: 400, height: 240 }, { x: 350, y: 0, width: 100, height: 60 }), /inside/)
})

function painted(cells = pattern, cell = 24, cropped = 0, thumbnail = false) {
  const image = { width: 320 - cropped, height: 340, data: Buffer.alloc((320 - cropped) * 340 * 4, 255) }
  const left = 60 + (24 - cell) * 4
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const row = Math.floor((y - 70) / cell), column = Math.floor((x - left) / cell)
    const smallRow = Math.floor((y - 80) / 5), smallColumn = Math.floor((x - 5) / 5)
    const color = row >= 0 && row < 8 && column >= 0 && column < 8
      ? palette[cells[row * 8 + column]]
      : thumbnail && smallRow >= 0 && smallRow < 8 && smallColumn >= 0 && smallColumn < 8
        ? palette[cells[smallRow * 8 + smallColumn]]
        : x >= 8 && x < 24 && y >= 8 && y < 24 ? palette[2] : null
    if (color) for (let channel = 0; channel < 3; channel++) image.data[(y * image.width + x) * 4 + channel] = color[channel]
  }
  return PNG.sync.write(image)
}

test('decodes every cell from a painted pattern while ignoring a small toolbar-colored icon', () => {
  for (const cell of [12, 24]) {
    const result = decodePreviewPattern(painted(pattern, cell), palette)
    assert.deepEqual(result.pattern, pattern)
    const left = 60 + (24 - cell) * 4
    assert.deepEqual(result.bounds, { left, right: left + 8 * cell - 1, top: 70, bottom: 70 + 8 * cell - 1 })
  }
})

test('a sidebar thumbnail overlapping the document rows cannot merge into the main pattern bounds', () => {
  const result = decodePreviewPattern(painted(pattern, 24, 0, true), palette)
  assert.deepEqual(result.pattern, pattern)
  assert.deepEqual(result.bounds, { left: 60, right: 251, top: 70, bottom: 261 })
})

test('a readable sidebar thumbnail alone is not evidence of a rendered document page', () => {
  const image = { width: 500, height: 300, data: Buffer.alloc(500 * 300 * 4, 255) }
  for (let y = 60; y < 156; y++) for (let x = 20; x < 116; x++) {
    const color = palette[pattern[Math.floor((y - 60) / 12) * 8 + Math.floor((x - 20) / 12)]]
    for (let channel = 0; channel < 3; channel++) image.data[(y * image.width + x) * 4 + channel] = color[channel]
  }
  assert.equal(decodePreviewPattern(PNG.sync.write(image), palette), null)
})

test('a changed cell is observable and blank or incomplete content cannot decode as the expected file', () => {
  const changed = [...pattern]
  changed[27] = (changed[27] + 1) % 4
  assert.notDeepEqual(decodePreviewPattern(painted(changed), palette).pattern, pattern)
  assert.equal(decodePreviewPattern(PNG.sync.write({ width: 320, height: 340, data: Buffer.alloc(320 * 340 * 4, 255) }), palette), null)
  assert.equal(decodePreviewPattern(painted(pattern, 24, 100), palette), null)
  assert.equal(decodePreviewPattern(Buffer.alloc(0), palette), null)
})

test('the image fixture encodes the distinct colored panels, underline and untouched border', async () => {
  const document = await previewDocument('image', 'synthetic-image')
  assert.deepEqual(previewImageSamples(document.bytes), [[224, 24, 48, 255], [16, 144, 80, 255], [24, 96, 224, 255], [0, 0, 0, 255], [255, 255, 255, 255]])
  const decoded = PNG.sync.read(document.bytes)
  assert.deepEqual({ width: decoded.width, height: decoded.height }, { width: 320, height: 192 })
})
