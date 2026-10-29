import { createRequire } from 'node:module'
import { knowledgeDocument } from './acceptance-knowledge-formats'

interface PngImage { width: number; height: number; data: Buffer }
const { PNG } = createRequire(import.meta.url)('pngjs') as {
  PNG: { sync: { read(bytes: Buffer): PngImage; write(image: PngImage): Buffer } }
}

export type DomPreviewFormat = 'markdown' | 'code' | 'html' | 'image' | 'json' | 'csv' | 'docx' | 'xlsx'
export const previewQuantity = '87261345.25'

export async function previewDocument(format: DomPreviewFormat, marker: string) {
  if (format === 'html' || format === 'csv' || format === 'docx' || format === 'xlsx') {
    const document = await knowledgeDocument(format, marker)
    return { ...document, name: `preview-reference.${format}` }
  }
  if (format === 'markdown') return {
    name: 'preview-reference.md',
    bytes: Buffer.from(`# Preview report\n\nReference: **${marker}**\n\n- Quantity: ${previewQuantity}\n- Status: ready\n`),
  }
  if (format === 'code') return {
    name: 'preview-reference.ts',
    bytes: Buffer.from(`export const reference = "${marker}"\nexport const quantity = ${previewQuantity}\n`),
  }
  if (format === 'json') return {
    name: 'preview-reference.json',
    bytes: Buffer.from(JSON.stringify({ reference: marker, quantity: Number(previewQuantity), ready: true }, null, 2) + '\n'),
  }
  const image: PngImage = { width: 320, height: 192, data: Buffer.alloc(320 * 192 * 4, 255) }
  const fill = (left: number, top: number, width: number, height: number, color: number[]) => {
    for (let y = top; y < top + height; y++) for (let x = left; x < left + width; x++) {
      const at = (y * image.width + x) * 4
      for (let channel = 0; channel < 3; channel++) image.data[at + channel] = color[channel]
    }
  }
  fill(20, 20, 80, 120, [224, 24, 48])
  fill(120, 20, 80, 120, [16, 144, 80])
  fill(220, 20, 80, 120, [24, 96, 224])
  fill(20, 160, 280, 12, [0, 0, 0])
  return { name: 'preview-reference.png', bytes: PNG.sync.write(image) }
}

export function previewImageSamples(bytes: Buffer) {
  const image = PNG.sync.read(bytes)
  return [[50, 70], [150, 70], [250, 70], [160, 165], [5, 5]].map(([x, y]) => {
    const column = Math.min(image.width - 1, Math.floor(x / 320 * image.width))
    const row = Math.min(image.height - 1, Math.floor(y / 192 * image.height))
    return Array.from(image.data.subarray((row * image.width + column) * 4, (row * image.width + column) * 4 + 4))
  })
}

export function cropPreviewFrame(bytes: Buffer, viewport: { width: number; height: number }, bounds: { x: number; y: number; width: number; height: number }) {
  if (![viewport.width, viewport.height, bounds.width, bounds.height].every(value => Number.isFinite(value) && value > 0)
    || ![bounds.x, bounds.y].every(value => Number.isFinite(value) && value >= 0)
    || bounds.x + bounds.width > viewport.width || bounds.y + bounds.height > viewport.height) {
    throw new Error('The preview crop must fit inside the measured viewport')
  }
  const image = PNG.sync.read(bytes)
  const scaleX = image.width / viewport.width, scaleY = image.height / viewport.height
  if (Math.abs(scaleX - scaleY) > Math.max(scaleX, scaleY) * 0.01) throw new Error('The full window screenshot does not match the measured viewport proportions')
  const left = Math.round(bounds.x * scaleX), top = Math.round(bounds.y * scaleY)
  const width = Math.round((bounds.x + bounds.width) * scaleX) - left
  const height = Math.round((bounds.y + bounds.height) * scaleY) - top
  const data = Buffer.alloc(width * height * 4)
  for (let row = 0; row < height; row++) {
    const start = ((top + row) * image.width + left) * 4
    image.data.copy(data, row * width * 4, start, start + width * 4)
  }
  return { bytes: PNG.sync.write({ width, height, data }), source: { width: image.width, height: image.height }, pixels: { left, top, width, height }, scale: { x: scaleX, y: scaleY } }
}

export function decodePreviewPattern(bytes: Buffer, palette: number[][]) {
  if (bytes.length === 0) return null
  const image = PNG.sync.read(bytes)
  const colorAt = (x: number, y: number) => {
    const at = (y * image.width + x) * 4
    return palette.findIndex(color => color.every((component, channel) => Math.abs(image.data[at + channel] - component) <= 18) && image.data[at + 3] === 255)
  }
  const rows: Array<{ y: number; left: number; right: number; count: number }> = []
  let widest = 0
  for (let y = 0; y < image.height; y++) {
    let left = -1, right = -1, count = 0
    let longest = { y, left: image.width, right: -1, count: 0 }
    const finishRun = () => {
      if (count > longest.count) longest = { y, left, right, count }
    }
    for (let x = 0; x < image.width; x++) if (colorAt(x, y) >= 0) {
      // A PDF sidebar can paint the same pattern as a separate thumbnail.
      // Only bridge rasterized cell edges, never the gap between two pages.
      if (left < 0 || x - right > 3) {
        finishRun()
        left = x
        count = 0
      }
      right = x
      count++
    }
    finishRun()
    widest = Math.max(widest, longest.count)
    rows.push(longest)
  }
  if (widest < 80) return null
  const dense = rows.filter(row => row.count >= widest * 0.9)
  const bounds = {
    left: Math.min(...dense.map(row => row.left)), right: Math.max(...dense.map(row => row.right)),
    top: dense[0].y, bottom: dense.at(-1)!.y,
  }
  const width = bounds.right - bounds.left + 1
  const height = bounds.bottom - bounds.top + 1
  // The fresh default PDF layout places thumbnail copies in the left sidebar.
  if (bounds.right < image.width / 2) return null
  if (width < 80 || height < 80 || Math.abs(width - height) > Math.max(width, height) * 0.03) return null
  const pattern: number[] = []
  for (let row = 0; row < 8; row++) for (let column = 0; column < 8; column++) {
    const x = Math.floor(bounds.left + (column + 0.5) * width / 8)
    const y = Math.floor(bounds.top + (row + 0.5) * height / 8)
    const color = colorAt(x, y)
    if (color < 0) return null
    pattern.push(color)
  }
  return { width: image.width, height: image.height, bounds, pattern }
}
