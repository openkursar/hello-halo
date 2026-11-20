/**
 * Agent Module - Tool-result images as files
 *
 * A tool may return images (Read of a picture, a browser screenshot). The
 * engine keeps them as base64 blocks; Halo's display copy of the step — the
 * Thought, the transcript line — gets each image written once as a file and a
 * `image_file` reference in its place (`shared/tool-result-images.ts`), so the
 * work process no longer carries megabytes of base64 through events, memory
 * and saves.
 *
 * Every function here returns a copy and never changes its input: the SDK
 * message is shared with other consumers, and what the engine receives must
 * stay exactly what it was. When a file cannot be written the image stays
 * inline, as before.
 *
 * Kept free of service imports: `apps/runtime` imports this file directly.
 */

import { createHash } from 'crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { TOOL_IMAGE_FILE_BLOCK, type ToolImageFileBlock } from '../../../shared/tool-result-images'

const MEDIA_TYPE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
}

/** Content-addressed file name: the same image is stored once per folder. */
export function contentAddressedImageName(base64: string, mediaType: string): string {
  const hash = createHash('sha256').update(base64).digest('hex').slice(0, 16)
  return `${hash}${MEDIA_TYPE_EXTENSIONS[mediaType] ?? '.png'}`
}

interface InlineImage {
  data: string
  mediaType: string
}

/** A tool-result image block in the Anthropic (`source.base64`) or MCP (`data` + `mimeType`) shape. */
function inlineImageOf(block: unknown): InlineImage | null {
  if (!block || typeof block !== 'object') return null
  const record = block as Record<string, unknown>
  if (record.type !== 'image') return null
  const source = record.source as Record<string, unknown> | undefined
  if (source && source.type === 'base64' && typeof source.data === 'string' && source.data) {
    return { data: source.data, mediaType: typeof source.media_type === 'string' ? source.media_type : 'image/png' }
  }
  if (typeof record.data === 'string' && record.data) {
    return { data: record.data, mediaType: typeof record.mimeType === 'string' ? record.mimeType : 'image/png' }
  }
  return null
}

function decodedLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(base64.length * 3 / 4) - padding)
}

/**
 * Saved references by image block. The transcript writer and the live display
 * copy see the same SDK objects, so the second one reuses the first one's file
 * instead of hashing megabytes again.
 */
const savedBlocks = new WeakMap<object, { dir: string; ref: ToolImageFileBlock }>()

/** Folders whose write failure was already reported; every image retries. */
const reportedFolders = new Set<string>()

function saveImage(block: object, image: InlineImage, dir: string): ToolImageFileBlock | null {
  const known = savedBlocks.get(block)
  if (known && known.dir === dir) return known.ref
  const path = join(dir, contentAddressedImageName(image.data, image.mediaType))
  try {
    if (!existsSync(path)) {
      mkdirSync(dir, { recursive: true })
      const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
      try {
        writeFileSync(temporary, Buffer.from(image.data, 'base64'))
        renameSync(temporary, path)
      } finally {
        rmSync(temporary, { force: true })
      }
    }
  } catch (error) {
    if (!reportedFolders.has(dir)) {
      reportedFolders.add(dir)
      console.warn(`[Agent] Tool image kept inline: could not write it to ${dir}`, error)
    }
    return null
  }
  const ref: ToolImageFileBlock = { type: TOOL_IMAGE_FILE_BLOCK, path, media_type: image.mediaType, bytes: decodedLength(image.data) }
  savedBlocks.set(block, { dir, ref })
  return ref
}

/**
 * Tool-result content with each inline image replaced by a file reference.
 * Returns the same value when it holds no image (or none could be saved).
 */
export function withImageFiles(content: unknown, dir: string): unknown {
  if (!Array.isArray(content)) return content
  let changed = false
  const blocks = content.map((block) => {
    const image = inlineImageOf(block)
    if (!image) return block
    const ref = saveImage(block as object, image, dir)
    if (!ref) return block
    changed = true
    return ref
  })
  return changed ? blocks : content
}

/**
 * The display text of a tool result's content: text as it is, block arrays as
 * JSON — with images as file references when a folder is given.
 */
export function toolResultDisplayText(content: unknown, imagesDir?: string | null): string {
  if (typeof content === 'string') return content
  return JSON.stringify(imagesDir ? withImageFiles(content, imagesDir) : content)
}

/** Whether an SDK user message carries a tool-result image inline. */
export function hasInlineToolImages(message: unknown): boolean {
  const record = message as { type?: unknown; message?: { content?: unknown } } | null
  if (!record || record.type !== 'user' || !Array.isArray(record.message?.content)) return false
  return record.message.content.some((block) => {
    if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'tool_result') return false
    const inner = (block as { content?: unknown }).content
    return Array.isArray(inner) && inner.some(item => inlineImageOf(item) !== null)
  })
}

/**
 * An SDK message as a transcript stores it: a user message whose tool results
 * carry images gets them as file references. Any other message, or one whose
 * images could not be saved, is returned as the same object.
 */
export function withToolResultImageFiles<T>(message: T, dir: string): T {
  const record = message as { type?: unknown; message?: { content?: unknown } } | null
  if (!record || record.type !== 'user') return message
  const content = record.message?.content
  if (!Array.isArray(content)) return message
  let changed = false
  const blocks = content.map((block) => {
    if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'tool_result') return block
    const inner = (block as { content?: unknown }).content
    const replaced = withImageFiles(inner, dir)
    if (replaced === inner) return block
    changed = true
    return { ...(block as object), content: replaced }
  })
  if (!changed) return message
  return { ...record, message: { ...record.message, content: blocks } } as T
}
