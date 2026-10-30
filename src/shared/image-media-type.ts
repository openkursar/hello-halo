import type { ImageMediaType } from './types/image-attachment'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))

/**
 * An image's real type from its leading bytes, or null when it is none of the
 * types a model accepts. Sources label images by file name or habit (a
 * screenshot sent as `.jpg`), and a model refuses an image whose declared type
 * does not match its bytes.
 */
export function detectImageMediaType(bytes: Uint8Array): ImageMediaType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return 'image/png'
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) return 'image/gif'
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp'
  return null
}
