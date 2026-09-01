/**
 * iLink Media — CDN media protocol for the WeChat iLink Bot integration.
 *
 * Owns everything between an iLink media handle and plaintext bytes:
 * AES-128-ECB + PKCS7, the several AES key encodings the protocol uses,
 * CDN URL construction, and the download / upload flows.
 *
 * Layering: sits on ilink-api.ts (transport, auth headers, constants) and is
 * consumed by weixin-ilink.provider.ts, which only deals in local files and
 * message envelopes and never sees ciphertext or CDN parameters.
 *
 * Diagnostics carry sizes, MIME, encrypt_type and key source only — never key
 * material and never bytes of user media.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import {
  ILINK_BASE_URL,
  CHANNEL_VERSION,
  buildAuthHeaders,
  fetchBinary,
  fetchJson,
  type IlinkRawResponse,
} from './ilink-api'

// ============================================
// Constants
// ============================================

const CDN_UPLOAD_URL = 'https://novac2c.cdn.weixin.qq.com/c2c/upload'
const CDN_DOWNLOAD_URL = 'https://novac2c.cdn.weixin.qq.com/c2c/download'

const AES_BLOCK_SIZE = 16
const AES_CIPHER = 'aes-128-ecb'

/** Hard cap on a single media transfer — the payload is buffered in memory. */
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024

/** Socket-inactivity budget; on its own it cannot bound a slow-drip response. */
const DOWNLOAD_TIMEOUT_MS = 30_000
/** Wall-clock ceiling on one download, so a trickling CDN cannot hold a slot. */
const DOWNLOAD_DEADLINE_MS = 90_000
const UPLOAD_TIMEOUT_MS = 120_000
const UPLOAD_DEADLINE_MS = 180_000
const UPLOAD_ATTEMPTS = 3
const UPLOAD_RETRY_BASE_DELAY_MS = 500

/**
 * media_type values for getuploadurl. Deliberately distinct from the
 * item_list `type` numbering used when sending the message.
 */
const UPLOAD_MEDIA_TYPE: Record<IlinkMediaKind, number> = {
  image: 1,
  video: 2,
  voice: 3,
  file: 4,
}

const LOG_TAG = '[IlinkMedia]'

// ============================================
// Types
// ============================================

/** Reference to an encrypted object on the WeChat C2C CDN. */
export interface IlinkCdnMedia {
  url?: string
  encrypt_query_param?: string
  aes_key?: string
  encrypt_type?: number
}

/** Fields shared by image_item / voice_item / video_item / file_item. */
export interface IlinkMediaItem {
  media?: IlinkCdnMedia
  aeskey?: string
  url?: string
}

export type IlinkMediaKind = 'image' | 'voice' | 'video' | 'file'

/** MIME types accepted for inline (multimodal) image input. */
export type IlinkImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

export interface IlinkMediaContent {
  data: Buffer
  mime: string
}

export interface IlinkUploadRequest {
  baseUrl?: string
  botToken: string
  toUserId: string
  kind: IlinkMediaKind
  data: Buffer
}

export interface IlinkUploadResult {
  media: IlinkCdnMedia
  /** Size of the encrypted CDN object — echoed back as mid_size / file_size. */
  ciphertextSize: number
}

interface GetUploadUrlResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  upload_param?: string
}

// ============================================
// Crypto
// ============================================

/**
 * Decode an AES-128 key from any of the encodings the protocol uses:
 * base64 of a hex string, base64 of the raw 16 bytes, or a bare hex string.
 * Returns null when the value matches none of them.
 */
export function decodeAesKey(encoded: string): Buffer | null {
  if (!encoded) return null

  const fromBase64 = tryBase64(encoded)
  if (fromBase64) {
    if (fromBase64.length === AES_BLOCK_SIZE * 2) {
      const fromHex = tryHex(fromBase64.toString('latin1'))
      if (fromHex) return fromHex
    }
    if (fromBase64.length === AES_BLOCK_SIZE) return fromBase64
  }

  return tryHex(encoded)
}

/** Strip PKCS7 padding. Throws when the padding is not well-formed. */
export function stripPkcs7(buf: Buffer): Buffer {
  if (buf.length === 0) throw new Error('PKCS7: empty input')
  const padding = buf[buf.length - 1]
  if (padding < 1 || padding > AES_BLOCK_SIZE || padding > buf.length) {
    throw new Error(`PKCS7: invalid padding value ${padding}`)
  }
  for (let i = buf.length - padding; i < buf.length; i++) {
    if (buf[i] !== padding) throw new Error(`PKCS7: invalid padding at byte ${i}`)
  }
  return buf.subarray(0, buf.length - padding)
}

/** AES-128-ECB decrypt + PKCS7 unpad. Throws on any integrity failure. */
export function aesEcbDecrypt(key: Buffer, ciphertext: Buffer): Buffer {
  if (ciphertext.length === 0 || ciphertext.length % AES_BLOCK_SIZE !== 0) {
    throw new Error(`ciphertext length ${ciphertext.length} is not a multiple of ${AES_BLOCK_SIZE}`)
  }
  const decipher = createDecipheriv(AES_CIPHER, key, null)
  decipher.setAutoPadding(false)
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return stripPkcs7(plain)
}

/** AES-128-ECB encrypt with PKCS7 padding. */
export function aesEcbEncrypt(key: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv(AES_CIPHER, key, null)
  cipher.setAutoPadding(true)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

// ============================================
// CDN URL
// ============================================

/**
 * Build the public download URL for an inbound media handle. iLink returns the
 * query parameter as a bare value, so it is wrapped in the key the CDN expects.
 *
 * `fallbackUrl` is the item-level url carried by voice_item / video_item /
 * file_item. It substitutes for an empty `media.url` everywhere, including as
 * the base the query parameter is appended to — an item that names its own host
 * must not have its download redirected to the generic CDN host.
 */
export function mediaDownloadUrl(media: IlinkCdnMedia | undefined, fallbackUrl?: string): string {
  const base = media?.url || fallbackUrl || ''
  const param = media?.encrypt_query_param ?? ''
  if (!param) return base

  const target = base || CDN_DOWNLOAD_URL
  const separator = target.includes('?') ? '&' : '?'
  return `${target}${separator}encrypted_query_param=${encodeURIComponent(param)}`
}

// ============================================
// MIME detection
// ============================================

/** Identify an image by magic bytes. Returns null for anything else. */
export function detectImageMime(buf: Buffer): IlinkImageMime | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (buf.length >= 6 && (buf.subarray(0, 6).toString('latin1') === 'GIF87a' || buf.subarray(0, 6).toString('latin1') === 'GIF89a')) {
    return 'image/gif'
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

const FALLBACK_MIME: Record<IlinkMediaKind, string> = {
  image: 'image/jpeg',
  voice: 'audio/silk',
  video: 'video/mp4',
  file: 'application/octet-stream',
}

// ============================================
// Inbound download
// ============================================

/**
 * Download and decrypt one inbound media item.
 *
 * Images may arrive as plaintext, so recognised image magic bytes are accepted
 * as-is. That shortcut stays image-only: for voice/video/file the content is
 * arbitrary binary, and successful PKCS7 unpadding is the only integrity signal.
 */
export async function downloadIlinkMedia(
  item: IlinkMediaItem,
  kind: IlinkMediaKind,
  signal?: AbortSignal,
): Promise<IlinkMediaContent> {
  const media = item.media
  const url = mediaDownloadUrl(media, item.url)
  if (!url) throw new Error(`${kind}: media handle carries no download URL`)

  const { key, source } = resolveMediaKey(item, kind)

  const res = await fetchBinary({
    method: 'GET',
    url,
    maxBytes: MAX_MEDIA_BYTES,
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    deadlineMs: DOWNLOAD_DEADLINE_MS,
    signal,
  })
  if (res.status !== 200) {
    throw new Error(`${kind}: CDN download failed with status ${res.status}`)
  }

  const raw = res.body
  console.log(
    `${LOG_TAG} downloaded kind=${kind} bytes=${raw.length} ` +
    `encryptType=${media?.encrypt_type ?? 0} keySource=${source}`
  )

  if (kind === 'image') {
    const rawMime = detectImageMime(raw)
    if (rawMime) return { data: raw, mime: rawMime }
  }

  if (!key) {
    throw new Error(
      `${kind}: no usable AES key (keySource=${source} bytes=${raw.length} ` +
      `encryptType=${media?.encrypt_type ?? 0})`
    )
  }

  const plain = aesEcbDecrypt(key, raw)

  if (kind === 'image') {
    const mime = detectImageMime(plain)
    if (!mime) {
      // WeChat also carries BMP/TIFF and the like as images. Those are still
      // worth handing over as a file; only inlining them is unsafe, and the
      // generic MIME is what tells the caller not to.
      console.warn(
        `${LOG_TAG} decrypted image is not an inlineable type, staging as a file ` +
        `(keySource=${source} bytes=${plain.length})`
      )
      return { data: plain, mime: FALLBACK_MIME.file }
    }
    console.log(`${LOG_TAG} decrypted kind=${kind} bytes=${plain.length} mime=${mime}`)
    return { data: plain, mime }
  }

  console.log(`${LOG_TAG} decrypted kind=${kind} bytes=${plain.length}`)
  return { data: plain, mime: FALLBACK_MIME[kind] }
}

/**
 * The item-level `aeskey` (bare hex) and `media.aes_key` (base64 of hex) are
 * two encodings of the same key; the item-level one wins when both are present.
 */
function resolveMediaKey(item: IlinkMediaItem, kind: IlinkMediaKind): {
  key: Buffer | null
  source: string
} {
  if (item.aeskey) {
    const key = decodeAesKey(item.aeskey)
    if (key) return { key, source: `${kind}_item.aeskey` }
    console.warn(`${LOG_TAG} unrecognised ${kind}_item.aeskey format, falling back to media.aes_key`)
  }
  if (item.media?.aes_key) {
    const key = decodeAesKey(item.media.aes_key)
    if (key) return { key, source: 'media.aes_key' }
    console.warn(`${LOG_TAG} unrecognised media.aes_key format for ${kind}`)
  }
  return { key: null, source: 'none' }
}

// ============================================
// Outbound upload
// ============================================

/**
 * Encrypt and upload a file to the WeChat CDN, returning the media handle to
 * embed in a sendmessage item.
 */
export async function uploadIlinkMedia(req: IlinkUploadRequest): Promise<IlinkUploadResult> {
  const { data, kind, toUserId, botToken } = req
  if (data.length === 0) throw new Error('upload: empty file')
  if (data.length > MAX_MEDIA_BYTES) {
    throw new Error(`upload: file of ${data.length} bytes exceeds the ${MAX_MEDIA_BYTES} byte limit`)
  }

  const aesKey = randomBytes(AES_BLOCK_SIZE)
  const aesKeyHex = aesKey.toString('hex')
  const fileKeyHex = randomBytes(AES_BLOCK_SIZE).toString('hex')
  // PKCS7 always appends a full block when the input is block-aligned.
  const ciphertextSize = (Math.floor(data.length / AES_BLOCK_SIZE) + 1) * AES_BLOCK_SIZE

  const baseUrl = req.baseUrl || ILINK_BASE_URL
  const uploadUrlResponse = await fetchJson<GetUploadUrlResponse>(
    'POST',
    `${baseUrl}/ilink/bot/getuploadurl`,
    buildAuthHeaders(botToken),
    {
      filekey: fileKeyHex,
      media_type: UPLOAD_MEDIA_TYPE[kind],
      to_user_id: toUserId,
      rawsize: data.length,
      rawfilemd5: createHash('md5').update(data).digest('hex'),
      filesize: ciphertextSize,
      no_need_thumb: true,
      aeskey: aesKeyHex,
      base_info: { channel_version: CHANNEL_VERSION },
    },
  )

  const ret = uploadUrlResponse.ret ?? uploadUrlResponse.errcode ?? 0
  if (ret !== 0) {
    throw new Error(`getuploadurl failed: ret=${ret} msg=${uploadUrlResponse.errmsg ?? ''}`)
  }
  if (!uploadUrlResponse.upload_param) {
    throw new Error('getuploadurl returned no upload_param')
  }

  const ciphertext = aesEcbEncrypt(aesKey, data)
  const cdnUrl =
    `${CDN_UPLOAD_URL}?encrypted_query_param=${encodeURIComponent(uploadUrlResponse.upload_param)}` +
    `&filekey=${fileKeyHex}`
  const downloadParam = await uploadToCdn(cdnUrl, ciphertext)

  console.log(
    `${LOG_TAG} uploaded kind=${kind} rawBytes=${data.length} cipherBytes=${ciphertext.length}`
  )

  return {
    media: {
      encrypt_query_param: downloadParam,
      aes_key: Buffer.from(aesKeyHex).toString('base64'),
      encrypt_type: 1,
    },
    ciphertextSize,
  }
}

/**
 * Upload the ciphertext. Retrying is safe because the filekey is random per
 * call, but only transient failures earn one: a 4xx is the CDN rejecting this
 * request, and re-sending the whole ciphertext cannot change its mind.
 */
async function uploadToCdn(url: string, ciphertext: Buffer): Promise<string> {
  let lastError: unknown
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    try {
      const res = await fetchBinary({
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/octet-stream' },
        body: ciphertext,
        timeoutMs: UPLOAD_TIMEOUT_MS,
        deadlineMs: UPLOAD_DEADLINE_MS,
      })
      if (res.status !== 200) {
        throw new CdnUploadError(`CDN upload failed with status ${res.status}`, res.status)
      }

      // A 200 without the param is a truncated or rewritten response rather than
      // the CDN's verdict, so it stays retryable (plain Error, not CdnUploadError).
      const param = readDownloadParam(res)
      if (!param) throw new Error('CDN upload returned no download param')
      return param
    } catch (err) {
      lastError = err
      const message = err instanceof Error ? err.message : String(err)
      if (!isRetryableUploadError(err)) {
        console.warn(`${LOG_TAG} upload failed, not retryable: ${message}`)
        break
      }
      console.warn(`${LOG_TAG} upload attempt ${attempt}/${UPLOAD_ATTEMPTS} failed: ${message}`)
      if (attempt < UPLOAD_ATTEMPTS) {
        await delay(UPLOAD_RETRY_BASE_DELAY_MS * attempt)
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** Carries the HTTP status so the retry policy can tell the CDN's answer apart. */
class CdnUploadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'CdnUploadError'
  }
}

/** Transport failures and 429 / 5xx are worth another attempt; nothing else is. */
function isRetryableUploadError(err: unknown): boolean {
  if (!(err instanceof CdnUploadError)) return true
  return err.status === 429 || err.status >= 500
}

function readDownloadParam(res: IlinkRawResponse): string {
  const header = res.headers['x-encrypted-param']
  const fromHeader = Array.isArray(header) ? header[0] : header
  if (fromHeader) return fromHeader

  try {
    const parsed = JSON.parse(res.body.toString('utf8')) as { encrypt_query_param?: string }
    return parsed.encrypt_query_param ?? ''
  } catch {
    return ''
  }
}

// ============================================
// Helpers
// ============================================

function tryBase64(value: string): Buffer | null {
  const decoded = Buffer.from(value, 'base64')
  return decoded.length > 0 ? decoded : null
}

function tryHex(value: string): Buffer | null {
  if (value.length !== AES_BLOCK_SIZE * 2 || !/^[0-9a-fA-F]+$/.test(value)) return null
  return Buffer.from(value, 'hex')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
