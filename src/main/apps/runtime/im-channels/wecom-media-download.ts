/**
 * apps/runtime/im-channels -- WeCom Media Download (proxy-aware)
 *
 * Downloads encrypted inbound media (image/file/video) from WeCom's media
 * URLs and decrypts it with the per-message AES key.
 *
 * Exists because @wecom/aibot-node-sdk's WSClient.downloadFile goes through
 * the SDK's own private axios instance, which ignores the app/system proxy
 * (the ws handshake is proxied via wsOptions.agent, but that never covers
 * these plain HTTP downloads). This module reproduces the SDK's behaviour —
 * Content-Disposition filename parsing plus its public decryptFile helper —
 * on top of proxyFetch so media downloads follow the same proxy chain as
 * every other outbound HTTP call.
 */

import { decryptFile } from '@wecom/aibot-node-sdk'
import { proxyFetch } from '../../../services/proxy-fetch'

export interface WecomDownloadedMedia {
  buffer: Buffer
  filename?: string
}

/**
 * Fetch a WeCom media URL through the app proxy chain and decrypt it.
 *
 * @param aesKey - Base64 AES key from the message's image/file/video
 *   fragment. When absent the raw (unencrypted) body is returned, matching
 *   the SDK's downloadFile behaviour.
 */
export async function downloadWecomMedia(
  url: string,
  aesKey?: string,
): Promise<WecomDownloadedMedia> {
  const response = await proxyFetch(url)
  if (!response.ok) {
    throw new Error(`WeCom media download failed: HTTP ${response.status}`)
  }
  const encrypted = Buffer.from(await response.arrayBuffer())
  const filename = parseContentDispositionFilename(
    response.headers.get('content-disposition'),
  )
  const buffer = aesKey ? decryptFile(encrypted, aesKey) : encrypted
  return { buffer, filename }
}

/** RFC 5987 `filename*=UTF-8''...` first, then plain `filename="..."`. */
function parseContentDispositionFilename(header: string | null): string | undefined {
  if (!header) return undefined
  const utf8Match = header.match(/filename\*=UTF-8''([^;\s]+)/i)
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1])
    } catch {
      return undefined
    }
  }
  const match = header.match(/filename="?([^";\s]+)"?/i)
  if (match) {
    try {
      return decodeURIComponent(match[1])
    } catch {
      return undefined
    }
  }
  return undefined
}
