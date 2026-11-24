/**
 * Image Attachment — the multimodal image payload shared by every hop:
 * renderer input box → IPC/HTTP transport → app runtime → JSONL transcript →
 * message bubble.
 *
 * It lives in `shared` because each hop previously declared its own inline
 * copy, and a snake_case transport copy silently drifted from the camelCase
 * shape the runtime reads.
 */

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

export interface ImageAttachment {
  id: string
  type: 'image'
  mediaType: ImageMediaType
  /** Base64-encoded bytes, without the `data:` URI prefix */
  data: string
  name?: string
  /** Byte size of the encoded image */
  size?: number
  /**
   * Where the desktop renderer loads a stored conversation image from
   * (`halo-file://`); `data` is then empty. Never sent back as input.
   */
  url?: string
}

/** Input attachments carry inline bytes, never a persisted file URL. */
export function isImageAttachmentInput(value: unknown): value is ImageAttachment {
  if (!value || typeof value !== 'object') return false
  const image = value as Record<string, unknown>
  return typeof image.id === 'string' && image.id.length > 0
    && image.type === 'image'
    && ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(image.mediaType as string)
    && typeof image.data === 'string' && image.data.trim().length > 0
    && image.url === undefined
    && (image.name === undefined || typeof image.name === 'string')
    && (image.size === undefined || (typeof image.size === 'number' && Number.isFinite(image.size) && image.size >= 0))
}

/** `src` for an image attachment: its file URL, or its inline data. */
export function imageAttachmentSrc(image: Pick<ImageAttachment, 'url' | 'data' | 'mediaType'>): string {
  return image.url || `data:${image.mediaType};base64,${image.data}`
}
