import { describe, expect, it } from 'vitest'
import { detectImageMediaType } from '../../../src/shared/image-media-type'

const bytes = (...values: number[]) => new Uint8Array(values)
const text = (value: string, pad = 0) => new Uint8Array([...Buffer.from(value, 'latin1'), ...new Array(pad).fill(0)])

describe('image type from its bytes', () => {
  it('recognizes the types a model accepts', () => {
    expect(detectImageMediaType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg')
    expect(detectImageMediaType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image/png')
    expect(detectImageMediaType(text('GIF89a', 2))).toBe('image/gif')
    expect(detectImageMediaType(text('GIF87a'))).toBe('image/gif')
    expect(detectImageMediaType(text('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toBe('image/webp')
  })

  it('names a screenshot PNG whatever its file is called', () => {
    expect(detectImageMediaType(Buffer.from('iVBORw0KGgoAAAANSUhEUg==', 'base64'))).toBe('image/png')
  })

  it('answers null for anything else or too little', () => {
    expect(detectImageMediaType(text('%PDF-1.7'))).toBeNull()
    expect(detectImageMediaType(bytes(0xff, 0xd8))).toBeNull()
    expect(detectImageMediaType(bytes())).toBeNull()
  })
})
