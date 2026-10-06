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
function encryptLikeWecom(plaintext: Buffer, key = crypto.randomBytes(32)): { encrypted: Buffer; aesKey: string } {
  const iv = key.subarray(0, 16)
  const padLen = 32 - (plaintext.length % 32)
  const padded = Buffer.concat([plaintext, Buffer.alloc(padLen, padLen)])
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  cipher.setAutoPadding(false)
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()])
  return { encrypted, aesKey: key.toString('base64') }
}

/** Decrypt the way WeCom encrypts, leaving the padding in place. */
function decryptKeepingPadding(encrypted: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
  decipher.setAutoPadding(false)
  return Buffer.concat([decipher.update(encrypted), decipher.final()])
}

/** Whether a decrypted buffer ends in valid PKCS#7 padding to 32-byte blocks. */
function endsInValidPadding(decrypted: Buffer): boolean {
  const padLen = decrypted[decrypted.length - 1]
  if (padLen < 1 || padLen > 32 || padLen > decrypted.length) return false
  return decrypted.subarray(decrypted.length - padLen).every(byte => byte === padLen)
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
    // Fixed keys: a random wrong key decrypts to valid padding about once in 256 runs.
    const key = Buffer.alloc(32, 0x11)
    const wrongKey = Buffer.alloc(32, 0x22)
    const { encrypted } = encryptLikeWecom(Buffer.from('secret'), key)
    expect(endsInValidPadding(decryptKeepingPadding(encrypted, key))).toBe(true)
    expect(endsInValidPadding(decryptKeepingPadding(encrypted, wrongKey))).toBe(false)
    proxyFetchMock.mockResolvedValue(mockResponse(encrypted))

    await expect(
      downloadWecomMedia('https://wwcdn.example/media/6', wrongKey.toString('base64')),
    ).rejects.toThrow()
  })
})
