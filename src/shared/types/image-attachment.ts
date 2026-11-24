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

/** `src` for an image attachment: its file URL, or its inline data. */
export function imageAttachmentSrc(image: Pick<ImageAttachment, 'url' | 'data' | 'mediaType'>): string {
  return image.url || `data:${image.mediaType};base64,${image.data}`
}
