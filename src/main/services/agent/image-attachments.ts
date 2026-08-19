/**
 * Agent Module - Non-Vision Image Fallback
 *
 * When the conversation's model cannot accept image blocks, pasted images are
 * persisted into the space's attachment directory and the user message gains a
 * <halo_attachments> block listing the absolute file paths, so the model can
 * read them via the on-device `ocr_image` tool. Vision models are untouched —
 * image blocks pass through exactly as before.
 *
 * Ensuring the ocr_image tool is actually present is the CALLER's concern:
 * main chat opens the OCR toolset via the broker (send-message.ts), app chat
 * seeds the OCR MCP server unconditionally. This module stays broker-free.
 *
 * Without this fallback, images sent to a non-vision model are silently
 * stripped by the OpenAI-compat router and the model never learns they existed.
 */

import { createHash } from 'crypto'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { supportsVisionById } from '../../../shared/constants/model-capabilities'
import { getSpace } from '../space.service'
import type { ApiCredentials, ImageAttachment, ImageMediaType } from './types'
import type { ToolsetScope } from './toolsets/types'

/** Toolset/MCP server id providing the ocr_image tool (matches toolsets/registry). */
export const OCR_TOOLSET_ID = 'ocr'

const MEDIA_TYPE_EXTENSIONS: Record<ImageMediaType, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
}

/**
 * Effective vision capability for the resolved credentials. Resolution order
 * matches the renderer input gate and the OpenAI-compat router keep/strip
 * decision: explicit user override > provider-declared flag > id heuristic.
 */
export function modelAcceptsImages(credentials: ApiCredentials): boolean {
  return (
    credentials.visionOverride ??
    credentials.supportsVision ??
    supportsVisionById(credentials.model)
  )
}

/** Content-addressed file name: dedupes re-sends of the same image. */
export function attachmentFileName(image: ImageAttachment): string {
  const hash = createHash('sha256').update(image.data).digest('hex').slice(0, 16)
  return `${hash}${MEDIA_TYPE_EXTENSIONS[image.mediaType] ?? '.png'}`
}

export interface PersistedImageAttachment {
  /** Absolute path of the persisted image file */
  path: string
  /** Original file name from the user, when known */
  name?: string
}

/**
 * Build the <halo_attachments> prompt block for the persisted images.
 * Exported for unit tests; callers use prepareNonVisionImageFallback.
 */
export function formatImageAttachmentBlock(
  entries: PersistedImageAttachment[],
  droppedCount = 0
): string {
  const list = entries
    .map((e, i) => `${i + 1}. ${e.path}${e.name ? ` (${e.name})` : ''}`)
    .join('\n')
  const droppedNote = droppedCount > 0
    ? `\n${droppedCount} more image${droppedCount > 1 ? 's' : ''} could not be saved and ${droppedCount > 1 ? 'are' : 'is'} unavailable — mention this to the user.`
    : ''

  return `<halo_attachments>
The user attached ${entries.length} image${entries.length > 1 ? 's' : ''} to this message. The current model cannot view images directly, so each image was saved as a local file:
${list}${droppedNote}
To read their text content, call the ocr_image tool with these absolute paths (on-device, zero tokens). NEVER open these files with the Read tool or any other image-viewing tool — Read returns the image itself, which the current model cannot accept and which will fail the request. OCR extracts text only — it cannot describe visual layout, charts, or graphics; tell the user if the request depends on those.
</halo_attachments>

`
}

export interface NonVisionImageFallback {
  /** Prompt block to prepend to the outbound user message */
  contextBlock: string
}

/**
 * Apply the non-vision fallback for a user turn, if it is needed.
 *
 * Returns null when there is nothing to do (no images, or the model has
 * vision) — the caller then sends image blocks as usual. Otherwise persists
 * the images and returns the prompt block replacing the image blocks. The
 * caller must ensure the ocr_image tool is available in the session (see
 * module header).
 *
 * Failure never blocks the send: if persistence fails entirely, null is
 * returned and behavior degrades to the pre-existing path (router strips).
 */
export function prepareNonVisionImageFallback(params: {
  scope: ToolsetScope
  credentials: ApiCredentials
  images?: ImageAttachment[]
}): NonVisionImageFallback | null {
  const { scope, credentials, images } = params
  if (!images || images.length === 0) return null
  if (modelAcceptsImages(credentials)) return null

  const space = getSpace(scope.spaceId)
  if (!space) {
    console.warn(`[Agent][${scope.conversationId}] Non-vision image fallback skipped: space ${scope.spaceId} not found`)
    return null
  }

  // Mirrors the conversation storage layout: the temp space keeps data dirs at
  // its root, dedicated spaces keep them under .halo/.
  const dir = space.isTemp
    ? join(space.path, 'attachments')
    : join(space.path, '.halo', 'attachments')

  const entries: PersistedImageAttachment[] = []
  try {
    mkdirSync(dir, { recursive: true })
    for (const image of images) {
      try {
        const filePath = join(dir, attachmentFileName(image))
        if (!existsSync(filePath)) {
          writeFileSync(filePath, Buffer.from(image.data, 'base64'))
        }
        entries.push({ path: filePath, name: image.name })
      } catch (e) {
        console.error(`[Agent][${scope.conversationId}] Failed to persist image attachment ${image.name ?? image.id}:`, e)
      }
    }
  } catch (e) {
    console.error(`[Agent][${scope.conversationId}] Failed to create attachments dir ${dir}:`, e)
    return null
  }
  if (entries.length === 0) return null

  console.log(`[Agent][${scope.conversationId}] Non-vision fallback: ${entries.length}/${images.length} image(s) persisted for OCR (model=${credentials.model})`)
  return { contextBlock: formatImageAttachmentBlock(entries, images.length - entries.length) }
}
