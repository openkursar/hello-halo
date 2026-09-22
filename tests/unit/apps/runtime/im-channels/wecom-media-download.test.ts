/**
 * Unit tests for wecom-media-download.ts.
 *
 * The module exists so inbound WeCom media goes through proxyFetch instead
 * of the SDK's unproxied axios client — so the tests assert (1) the request
 * really goes to proxyFetch, (2) decryption matches the SDK's AES-256-CBC /
 * 32-byte-PKCS#7 scheme (real round-trip, no crypto mocks), and (3) the
 * Content-Disposition filename parsing mirrors the SDK's precedence rules.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'node:crypto'

vi.mock('../../../../../src/main/services/proxy-fetch', () => ({
  proxyFetch: vi.fn(),
}))

import { proxyFetch } from '../../../../../src/main/services/proxy-fetch'
import { downloadWecomMedia } from '../../../../../src/main/apps/runtime/im-channels/wecom-media-download'

const proxyFetchMock = vi.mocked(proxyFetch)

/** Encrypt like WeCom does: AES-256-CBC, IV = first 16 key bytes, PKCS#7 to 32-byte blocks. */
function encryptLikeWecom(plaintext: Buffer): { encrypted: Buffer; aesKey: string } {
  const key = crypto.randomBytes(32)
  const iv = key.subarray(0, 16)
  const padLen = 32 - (plaintext.length % 32)
  const padded = Buffer.concat([plaintext, Buffer.alloc(padLen, padLen)])
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  cipher.setAutoPadding(false)
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()])
  return { encrypted, aesKey: key.toString('base64') }
}

function mockResponse(body: Buffer, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(new Uint8Array(body), { status, headers })
}

beforeEach(() => {
  proxyFetchMock.mockReset()
})

describe('downloadWecomMedia', () => {
  it('downloads via proxyFetch and decrypts with the message AES key', async () => {
    const plaintext = Buffer.from('hello wecom media payload')
    const { encrypted, aesKey } = encryptLikeWecom(plaintext)
    proxyFetchMock.mockResolvedValue(mockResponse(encrypted))

    const result = await downloadWecomMedia('https://wwcdn.example/media/1', aesKey)

    expect(proxyFetchMock).toHaveBeenCalledWith('https://wwcdn.example/media/1')
    expect(result.buffer.equals(plaintext)).toBe(true)
    expect(result.filename).toBeUndefined()
  })

  it('returns the raw body when no AES key is provided', async () => {
    const body = Buffer.from('raw-bytes')
    proxyFetchMock.mockResolvedValue(mockResponse(body))

    const result = await downloadWecomMedia('https://wwcdn.example/media/2')
    expect(result.buffer.equals(body)).toBe(true)
  })

  it('parses RFC 5987 filename*=UTF-8 in preference to plain filename', async () => {
    const { encrypted, aesKey } = encryptLikeWecom(Buffer.from('x'))
    proxyFetchMock.mockResolvedValue(
      mockResponse(encrypted, {
        'content-disposition':
          `attachment; filename="fallback.bin"; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf`,
      }),
    )

    const result = await downloadWecomMedia('https://wwcdn.example/media/3', aesKey)
    expect(result.filename).toBe('报告.pdf')
  })

  it('parses plain filename="..." when no RFC 5987 form exists', async () => {
    const { encrypted, aesKey } = encryptLikeWecom(Buffer.from('x'))
    proxyFetchMock.mockResolvedValue(
      mockResponse(encrypted, { 'content-disposition': 'attachment; filename="photo.jpg"' }),
    )

    const result = await downloadWecomMedia('https://wwcdn.example/media/4', aesKey)
    expect(result.filename).toBe('photo.jpg')
  })

  it('throws on non-2xx responses', async () => {
    proxyFetchMock.mockResolvedValue(mockResponse(Buffer.from(''), {}, 403))

    await expect(downloadWecomMedia('https://wwcdn.example/media/5')).rejects.toThrow(
      'HTTP 403',
    )
  })

  it('throws when the key cannot decrypt the payload', async () => {
    const { encrypted } = encryptLikeWecom(Buffer.from('secret'))
    proxyFetchMock.mockResolvedValue(mockResponse(encrypted))
    const wrongKey = crypto.randomBytes(32).toString('base64')

    await expect(
      downloadWecomMedia('https://wwcdn.example/media/6', wrongKey),
    ).rejects.toThrow()
  })
})
