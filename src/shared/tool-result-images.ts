/**
 * Images returned by a tool, as a reply's work process keeps them.
 *
 * The engine receives a tool's image itself; Halo's own record of the step
 * stores it once as a file and refers to it from the tool's output, so the
 * record, its events and its saves stay small. A file-backed output is the
 * tool result's content blocks as JSON, each image replaced by an
 * `image_file` block. Records written before this held the base64 image in
 * the same JSON and are left as they are.
 *
 * Renderer-safe: no Node or Electron imports.
 */

export const TOOL_IMAGE_FILE_BLOCK = 'image_file'

export interface ToolImageFileBlock {
  type: typeof TOOL_IMAGE_FILE_BLOCK
  /** Absolute path of the saved image on the machine that ran the tool. */
  path: string
  media_type: string
  /** Size of the image file in bytes. */
  bytes: number
}

export type ToolOutputPart =
  | { type: 'text'; text: string }
  | ToolImageFileBlock

const MARKER = `"type":"${TOOL_IMAGE_FILE_BLOCK}"`

/**
 * Where Halo saves tool images: a `.images` folder beside the record it
 * belongs to, the file named by its content hash and the image's extension.
 */
const SAVED_IMAGE_PATH = /[\\/][^\\/]+\.images[\\/][0-9a-f]{16}\.(png|jpg|gif|webp)$/

function isImageFileBlock(value: Record<string, unknown>): value is Record<string, unknown> & ToolImageFileBlock {
  return value.type === TOOL_IMAGE_FILE_BLOCK
    && typeof value.path === 'string' && SAVED_IMAGE_PATH.test(value.path)
    && typeof value.media_type === 'string' && value.media_type.startsWith('image/')
    && typeof value.bytes === 'number' && Number.isFinite(value.bytes) && value.bytes >= 0
}

/**
 * The parts of a tool output that refers to saved images, in their order;
 * null for any other output (plain text, older base64 JSON, malformed JSON).
 * Blocks of other kinds are kept as their JSON text so nothing is hidden.
 */
export function readToolOutputImages(output: string): ToolOutputPart[] | null {
  if (!output.startsWith('[') || !output.includes(MARKER)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const parts: ToolOutputPart[] = []
  let images = 0
  for (const block of parsed) {
    if (!block || typeof block !== 'object') {
      parts.push({ type: 'text', text: JSON.stringify(block) })
      continue
    }
    const record = block as Record<string, unknown>
    if (isImageFileBlock(record)) {
      parts.push({ type: TOOL_IMAGE_FILE_BLOCK, path: record.path, media_type: record.media_type, bytes: record.bytes })
      images++
    } else if (record.type === 'text' && typeof record.text === 'string') {
      parts.push({ type: 'text', text: record.text })
    } else {
      parts.push({ type: 'text', text: JSON.stringify(record) })
    }
  }
  return images > 0 ? parts : null
}
