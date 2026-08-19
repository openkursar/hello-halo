/**
 * Unit tests for apps/runtime/im-channels/ilink-media.
 *
 * Covers the protocol surface end to end, with only HTTP mocked:
 *   - AES key decoding across the three encodings the protocol uses
 *   - AES-128-ECB + PKCS7 round-trip and padding rejection
 *   - CDN download URL construction and its fallbacks
 *   - Image magic-byte detection (gates the raw plaintext fast path)
 *   - download: status handling, key precedence, and the image-only fast path
 *   - upload: media_type numbering, ciphertext size, download-param sourcing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IlinkRawResponse } from '../../../../../src/main/apps/runtime/im-channels/ilink-api'

const fetchBinary = vi.fn()
const fetchJson = vi.fn()

vi.mock('../../../../../src/main/apps/runtime/im-channels/ilink-api', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../../../src/main/apps/runtime/im-channels/ilink-api')
  >()
  return {
    ...actual,
    fetchBinary: (...args: unknown[]) => fetchBinary(...args),
    fetchJson: (...args: unknown[]) => fetchJson(...args),
  }
})

const {
  decodeAesKey,
  stripPkcs7,
  aesEcbDecrypt,
  aesEcbEncrypt,
  mediaDownloadUrl,
  detectImageMime,
  downloadIlinkMedia,
  uploadIlinkMedia,
} = await import('../../../../../src/main/apps/runtime/im-channels/ilink-media')

const KEY_HEX = '0123456789abcdef0123456789abcdef'
const KEY_BYTES = Buffer.from(KEY_HEX, 'hex')
/** A second key, so "which key was used" becomes observable through the decrypt. */
const OTHER_KEY_HEX = 'fedcba9876543210fedcba9876543210'

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(24, 0x11),
])

/** Shape one CDN reply for the mocked transport. */
function cdnResponse(
  body: Buffer,
  status = 200,
  headers: Record<string, string> = {},
): IlinkRawResponse {
  return { status, headers, body }
}

beforeEach(() => {
  fetchBinary.mockReset()
  fetchJson.mockReset()
})

describe('decodeAesKey', () => {
  it('decodes base64 of a hex string (outbound convention)', () => {
    const encoded = Buffer.from(KEY_HEX).toString('base64')
    expect(decodeAesKey(encoded)).toEqual(KEY_BYTES)
  })

  it('decodes base64 of raw 16 bytes', () => {
    expect(decodeAesKey(KEY_BYTES.toString('base64'))).toEqual(KEY_BYTES)
  })

  it('decodes a bare hex string (inbound item aeskey)', () => {
    expect(decodeAesKey(KEY_HEX)).toEqual(KEY_BYTES)
  })

  it('returns null for an unrecognised format', () => {
    expect(decodeAesKey('not a key')).toBeNull()
    expect(decodeAesKey('')).toBeNull()
    expect(decodeAesKey('abcd')).toBeNull()
  })
})

describe('stripPkcs7', () => {
  it('removes the padding block', () => {
    const padded = Buffer.concat([Buffer.from('hello'), Buffer.alloc(11, 11)])
    expect(stripPkcs7(padded).toString()).toBe('hello')
  })

  it('rejects an out-of-range padding value', () => {
    expect(() => stripPkcs7(Buffer.from([1, 2, 3, 99]))).toThrow(/invalid padding value/)
    expect(() => stripPkcs7(Buffer.from([1, 2, 3, 0]))).toThrow(/invalid padding value/)
  })

  it('rejects inconsistent padding bytes', () => {
    expect(() => stripPkcs7(Buffer.from([1, 2, 4, 3, 3]))).toThrow(/invalid padding at byte/)
  })

  it('rejects empty input', () => {
    expect(() => stripPkcs7(Buffer.alloc(0))).toThrow(/empty input/)
  })
})

describe('aesEcbEncrypt / aesEcbDecrypt', () => {
  it('round-trips arbitrary bytes', () => {
    const plain = Buffer.from('the quick brown fox jumps over the lazy dog')
    expect(aesEcbDecrypt(KEY_BYTES, aesEcbEncrypt(KEY_BYTES, plain))).toEqual(plain)
  })

  it('appends a full padding block when the input is block-aligned', () => {
    const plain = Buffer.alloc(32, 7)
    const cipher = aesEcbEncrypt(KEY_BYTES, plain)
    expect(cipher.length).toBe(48)
    expect(aesEcbDecrypt(KEY_BYTES, cipher)).toEqual(plain)
  })

  it('rejects ciphertext that is not a multiple of the block size', () => {
    expect(() => aesEcbDecrypt(KEY_BYTES, Buffer.alloc(20))).toThrow(/not a multiple/)
    expect(() => aesEcbDecrypt(KEY_BYTES, Buffer.alloc(0))).toThrow(/not a multiple/)
  })

  it('rejects ciphertext decrypted with the wrong key', () => {
    const cipher = aesEcbEncrypt(KEY_BYTES, Buffer.from('secret payload'))
    const wrongKey = Buffer.alloc(16, 0xab)
    expect(() => aesEcbDecrypt(wrongKey, cipher)).toThrow(/PKCS7/)
  })
})

describe('mediaDownloadUrl', () => {
  it('falls back to the CDN download base when the handle carries no url', () => {
    expect(mediaDownloadUrl({ encrypt_query_param: 'abc+/=' })).toBe(
      'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=abc%2B%2F%3D'
    )
  })

  it('appends to an existing query string', () => {
    expect(mediaDownloadUrl({ url: 'https://cdn.example.com/dl?a=1', encrypt_query_param: 'p' }))
      .toBe('https://cdn.example.com/dl?a=1&encrypted_query_param=p')
  })

  it('uses the handle url as-is when there is no query param', () => {
    expect(mediaDownloadUrl({ url: 'https://cdn.example.com/dl' }))
      .toBe('https://cdn.example.com/dl')
  })

  it('falls back to the item-level url', () => {
    expect(mediaDownloadUrl({}, 'https://cdn.example.com/item'))
      .toBe('https://cdn.example.com/item')
    expect(mediaDownloadUrl(undefined, 'https://cdn.example.com/item'))
      .toBe('https://cdn.example.com/item')
  })

  it('uses the item-level url as the base the query parameter is appended to', () => {
    expect(mediaDownloadUrl({ encrypt_query_param: 'p' }, 'https://cdn.example.com/item'))
      .toBe('https://cdn.example.com/item?encrypted_query_param=p')
  })

  it('prefers the handle url over the item-level url', () => {
    expect(mediaDownloadUrl(
      { url: 'https://handle.example.com/dl', encrypt_query_param: 'p' },
      'https://cdn.example.com/item',
    )).toBe('https://handle.example.com/dl?encrypted_query_param=p')
  })

  it('returns an empty string when nothing is available', () => {
    expect(mediaDownloadUrl(undefined)).toBe('')
    expect(mediaDownloadUrl({})).toBe('')
  })
})

describe('detectImageMime', () => {
  it('recognises the supported image formats', () => {
    expect(detectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(detectImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])))
      .toBe('image/png')
    expect(detectImageMime(Buffer.from('GIF89a....'))).toBe('image/gif')
    expect(detectImageMime(Buffer.concat([
      Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'),
    ]))).toBe('image/webp')
  })

  it('returns null for ciphertext-shaped bytes and short inputs', () => {
    expect(detectImageMime(Buffer.alloc(64, 0x5a))).toBeNull()
    expect(detectImageMime(Buffer.from([0xff, 0xd8]))).toBeNull()
    expect(detectImageMime(Buffer.alloc(0))).toBeNull()
  })
})

describe('downloadIlinkMedia', () => {
  it('rejects a non-200 CDN response instead of decrypting the error body', async () => {
    fetchBinary.mockResolvedValue(cdnResponse(Buffer.from('<html>404</html>'), 404))

    await expect(
      downloadIlinkMedia({ media: { encrypt_query_param: 'p', aes_key: KEY_HEX } }, 'image'),
    ).rejects.toThrow(/status 404/)
  })

  it('accepts raw image bytes without a key (the image fast path)', async () => {
    fetchBinary.mockResolvedValue(cdnResponse(PNG))

    const result = await downloadIlinkMedia({ media: { encrypt_query_param: 'p' } }, 'image')
    expect(result.mime).toBe('image/png')
    expect(result.data).toEqual(PNG)
  })

  it('decrypts an image that did arrive encrypted', async () => {
    fetchBinary.mockResolvedValue(cdnResponse(aesEcbEncrypt(KEY_BYTES, PNG)))

    const result = await downloadIlinkMedia(
      { media: { encrypt_query_param: 'p' }, aeskey: KEY_HEX },
      'image',
    )
    expect(result.mime).toBe('image/png')
    expect(result.data).toEqual(PNG)
  })

  it('hands over an image format it cannot inline as a generic file', async () => {
    // A BMP: an image WeChat does carry, outside the four multimodal-safe types.
    const bmp = Buffer.concat([Buffer.from('BM'), Buffer.alloc(30, 0x07)])
    fetchBinary.mockResolvedValue(cdnResponse(aesEcbEncrypt(KEY_BYTES, bmp)))

    const result = await downloadIlinkMedia(
      { media: { encrypt_query_param: 'p' }, aeskey: KEY_HEX },
      'image',
    )
    expect(result.data).toEqual(bmp)
    expect(result.mime).toBe('application/octet-stream')
  })

  it('refuses the raw fast path for a file even when the bytes sniff as an image', async () => {
    fetchBinary.mockResolvedValue(cdnResponse(PNG))

    await expect(
      downloadIlinkMedia({ media: { encrypt_query_param: 'p' } }, 'file'),
    ).rejects.toThrow(/no usable AES key/)
  })

  it('refuses the raw fast path for voice and video too', async () => {
    fetchBinary.mockResolvedValue(cdnResponse(PNG))

    await expect(
      downloadIlinkMedia({ media: { encrypt_query_param: 'p' } }, 'voice'),
    ).rejects.toThrow(/no usable AES key/)
    await expect(
      downloadIlinkMedia({ media: { encrypt_query_param: 'p' } }, 'video'),
    ).rejects.toThrow(/no usable AES key/)
  })

  it('decrypts a file with the item-level aeskey in preference to media.aes_key', async () => {
    const payload = Buffer.from('%PDF-1.4 quarterly report')
    fetchBinary.mockResolvedValue(cdnResponse(aesEcbEncrypt(KEY_BYTES, payload)))

    const result = await downloadIlinkMedia(
      {
        media: {
          encrypt_query_param: 'p',
          // Would produce garbage if it were the one picked.
          aes_key: Buffer.from(OTHER_KEY_HEX).toString('base64'),
        },
        aeskey: KEY_HEX,
      },
      'file',
    )
    expect(result.data).toEqual(payload)
    expect(result.mime).toBe('application/octet-stream')
  })

  it('uses media.aes_key when the item carries no aeskey', async () => {
    const payload = Buffer.from('silk audio frames')
    fetchBinary.mockResolvedValue(cdnResponse(aesEcbEncrypt(KEY_BYTES, payload)))

    const result = await downloadIlinkMedia(
      { media: { encrypt_query_param: 'p', aes_key: Buffer.from(KEY_HEX).toString('base64') } },
      'voice',
    )
    expect(result.data).toEqual(payload)
    expect(result.mime).toBe('audio/silk')
  })

  it('falls back to media.aes_key when the item aeskey is unparseable', async () => {
    const payload = Buffer.from('mp4 atoms')
    fetchBinary.mockResolvedValue(cdnResponse(aesEcbEncrypt(KEY_BYTES, payload)))

    const result = await downloadIlinkMedia(
      {
        media: { encrypt_query_param: 'p', aes_key: Buffer.from(KEY_HEX).toString('base64') },
        aeskey: 'not-a-key',
      },
      'video',
    )
    expect(result.data).toEqual(payload)
  })

  it('downloads a file_item from the host the item names, not the generic CDN', async () => {
    fetchBinary.mockResolvedValue(cdnResponse(aesEcbEncrypt(KEY_BYTES, Buffer.from('doc'))))

    await downloadIlinkMedia(
      {
        media: { encrypt_query_param: 'q p' },
        url: 'https://items.example.com/file',
        aeskey: KEY_HEX,
      },
      'file',
    )
    expect(fetchBinary).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://items.example.com/file?encrypted_query_param=q%20p',
      }),
    )
  })

  it('rejects a handle with no usable URL before touching the network', async () => {
    await expect(downloadIlinkMedia({ media: {} }, 'file')).rejects.toThrow(/no download URL/)
    expect(fetchBinary).not.toHaveBeenCalled()
  })

  it('passes an abort signal and a wall-clock deadline to the transport', async () => {
    fetchBinary.mockResolvedValue(cdnResponse(PNG))
    const signal = new AbortController().signal

    await downloadIlinkMedia({ media: { encrypt_query_param: 'p' } }, 'image', signal)
    expect(fetchBinary).toHaveBeenCalledWith(
      expect.objectContaining({ signal, deadlineMs: expect.any(Number) }),
    )
  })
})

describe('uploadIlinkMedia', () => {
  const baseRequest = {
    botToken: 'token-abc',
    toUserId: 'user-1',
    kind: 'file' as const,
    data: Buffer.from('0123456789abcdef'),   // exactly one block
  }

  function mockUploadUrl(): void {
    fetchJson.mockResolvedValue({ ret: 0, upload_param: 'up param' })
  }

  it('sends the getuploadurl media_type numbering, which differs from item type', async () => {
    mockUploadUrl()
    fetchBinary.mockResolvedValue(cdnResponse(Buffer.alloc(0), 200, {
      'x-encrypted-param': 'dl-param',
    }))

    // A video is item type 5 on the wire but media_type 2 here.
    await uploadIlinkMedia({ ...baseRequest, kind: 'video' })
    expect(fetchJson.mock.calls[0][3]).toMatchObject({ media_type: 2 })

    fetchJson.mockClear()
    await uploadIlinkMedia({ ...baseRequest, kind: 'image' })
    expect(fetchJson.mock.calls[0][3]).toMatchObject({ media_type: 1 })

    fetchJson.mockClear()
    await uploadIlinkMedia({ ...baseRequest, kind: 'voice' })
    expect(fetchJson.mock.calls[0][3]).toMatchObject({ media_type: 3 })

    fetchJson.mockClear()
    await uploadIlinkMedia({ ...baseRequest, kind: 'file' })
    expect(fetchJson.mock.calls[0][3]).toMatchObject({ media_type: 4 })
  })

  it('reports the ciphertext size, which always adds a padding block', async () => {
    mockUploadUrl()
    fetchBinary.mockResolvedValue(cdnResponse(Buffer.alloc(0), 200, {
      'x-encrypted-param': 'dl-param',
    }))

    const aligned = await uploadIlinkMedia(baseRequest)
    expect(aligned.ciphertextSize).toBe(32)
    expect(fetchJson.mock.calls[0][3]).toMatchObject({ rawsize: 16, filesize: 32 })

    fetchJson.mockClear()
    const short = await uploadIlinkMedia({ ...baseRequest, data: Buffer.from('short') })
    expect(short.ciphertextSize).toBe(16)
    expect(fetchJson.mock.calls[0][3]).toMatchObject({ rawsize: 5, filesize: 16 })
  })

  it('takes the download reference from the X-Encrypted-Param header', async () => {
    mockUploadUrl()
    fetchBinary.mockResolvedValue(cdnResponse(
      Buffer.from(JSON.stringify({ encrypt_query_param: 'from-body' })),
      200,
      { 'x-encrypted-param': 'from-header' },
    ))

    const result = await uploadIlinkMedia(baseRequest)
    expect(result.media.encrypt_query_param).toBe('from-header')
    expect(result.media.encrypt_type).toBe(1)
    // The key travels back as base64 of the hex string, per the protocol.
    expect(Buffer.from(result.media.aes_key!, 'base64').toString()).toMatch(/^[0-9a-f]{32}$/)
  })

  it('falls back to the body when the header is absent', async () => {
    mockUploadUrl()
    fetchBinary.mockResolvedValue(cdnResponse(
      Buffer.from(JSON.stringify({ encrypt_query_param: 'from-body' })),
    ))

    const result = await uploadIlinkMedia(baseRequest)
    expect(result.media.encrypt_query_param).toBe('from-body')
  })

  it('uploads ciphertext, never the raw bytes', async () => {
    mockUploadUrl()
    fetchBinary.mockResolvedValue(cdnResponse(Buffer.alloc(0), 200, {
      'x-encrypted-param': 'dl-param',
    }))

    await uploadIlinkMedia(baseRequest)
    const sent = fetchBinary.mock.calls[0][0] as { url: string; body: Buffer }
    expect(sent.body).toHaveLength(32)
    expect(sent.body.equals(baseRequest.data)).toBe(false)
    expect(sent.url).toContain('encrypted_query_param=up%20param')
  })

  it('surfaces a non-zero ret from getuploadurl', async () => {
    fetchJson.mockResolvedValue({ ret: -1, errmsg: 'quota exceeded' })

    await expect(uploadIlinkMedia(baseRequest)).rejects.toThrow(/quota exceeded/)
    expect(fetchBinary).not.toHaveBeenCalled()
  })

  it('does not re-send the ciphertext after a 4xx the CDN will repeat', async () => {
    mockUploadUrl()
    fetchBinary.mockResolvedValue(cdnResponse(Buffer.alloc(0), 403))

    await expect(uploadIlinkMedia(baseRequest)).rejects.toThrow(/status 403/)
    expect(fetchBinary).toHaveBeenCalledTimes(1)
  })

  it('retries a 5xx up to the attempt limit', async () => {
    vi.useFakeTimers()
    try {
      mockUploadUrl()
      fetchBinary.mockResolvedValue(cdnResponse(Buffer.alloc(0), 503))

      const assertion = expect(uploadIlinkMedia(baseRequest)).rejects.toThrow(/status 503/)
      await vi.advanceTimersByTimeAsync(5_000)
      await assertion
      expect(fetchBinary).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a 200 that carries no download param', async () => {
    vi.useFakeTimers()
    try {
      mockUploadUrl()
      fetchBinary.mockResolvedValue(cdnResponse(Buffer.from('truncated')))

      const assertion = expect(uploadIlinkMedia(baseRequest))
        .rejects.toThrow(/no download param/)
      await vi.advanceTimersByTimeAsync(5_000)
      await assertion
      expect(fetchBinary).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a transport failure', async () => {
    vi.useFakeTimers()
    try {
      mockUploadUrl()
      fetchBinary.mockRejectedValue(new Error('socket hang up'))

      const assertion = expect(uploadIlinkMedia(baseRequest)).rejects.toThrow(/socket hang up/)
      await vi.advanceTimersByTimeAsync(5_000)
      await assertion
      expect(fetchBinary).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects an empty or oversized payload before contacting the API', async () => {
    await expect(uploadIlinkMedia({ ...baseRequest, data: Buffer.alloc(0) }))
      .rejects.toThrow(/empty file/)
    await expect(uploadIlinkMedia({ ...baseRequest, data: Buffer.alloc(26 * 1024 * 1024) }))
      .rejects.toThrow(/exceeds/)
    expect(fetchJson).not.toHaveBeenCalled()
  })
})
