/**
 * OCR MCP - MCP Server Definition
 *
 * Provides the `ocr_image` tool: local, offline text extraction from image files
 * by path. Runs entirely on-device (tesseract.js), consumes zero model tokens,
 * and never uploads image content.
 *
 * Interactive chat loads this on demand via the toolset broker; the automation
 * runtime seeds it unconditionally alongside web-search / memory.
 */

import { readFile, stat } from 'fs/promises'
import { tool, createSdkMcpServer } from '../agent/resolved-sdk'
import { z } from 'zod'
import { ocrImage } from './engine'

/** Extensions the bundled engine can decode; used only for a clearer up-front error. */
const OCR_IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.gif',
])

/**
 * Per-file size cap. Each file is fully buffered in the main process and the
 * tool accepts up to 20 paths per call, so an uncapped batch of huge scans
 * (e.g. 500 MB TIFFs) could spike main-process memory. 50 MB comfortably covers
 * real screenshots/scans while bounding a worst-case batch to ~1 GB.
 */
const MAX_IMAGE_BYTES = 50 * 1024 * 1024

function fileExtension(path: string): string {
  const lower = path.toLowerCase()
  const dot = lower.lastIndexOf('.')
  return dot < 0 ? '' : lower.slice(dot)
}

function buildOcrImageTool() {
  return tool(
    'ocr_image',
    `Extract text from local image files using an on-device OCR engine. Reads each image by absolute path and returns its recognized text.

This runs entirely on your machine (tesseract.js), consumes ZERO model tokens, and never uploads image content. It recognizes English and Simplified Chinese. It extracts text only — it does NOT describe or interpret what an image depicts.

When to use:
- Reading text from many local images (screenshots, scans, photos of documents) — far cheaper than attaching each image to the conversation.
- Verbatim, character-accurate extraction of long text, tables, or mixed Chinese/English content.
- Reading text from images when the current model has no vision capability.

When NOT to use:
- Understanding image content, layout, charts, or diagrams (attach the image to the conversation for a vision model instead).
- Chinese recognition is serviceable but not exact; treat the output as a best-effort transcription.

Returns: the extracted text per file, each under a "## <path>" heading. Files with no detectable text or that fail to read are reported inline without aborting the batch.`,
    {
      paths: z
        .array(z.string())
        .min(1)
        .max(20)
        .describe('Absolute paths of the image files to extract text from (1-20 files).'),
    },
    async (args) => {
      const segments: string[] = []

      for (const path of args.paths) {
        const ext = fileExtension(path)
        if (!OCR_IMAGE_EXTENSIONS.has(ext)) {
          segments.push(`## ${path}\n[skipped: not a supported image format]`)
          continue
        }
        try {
          const { size } = await stat(path)
          if (size > MAX_IMAGE_BYTES) {
            segments.push(`## ${path}\n[skipped: file is ${Math.round(size / 1024 / 1024)} MB, exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MB per-file limit]`)
            continue
          }
          const buf = await readFile(path)
          const text = await ocrImage(buf)
          segments.push(`## ${path}\n${text || '[no text detected]'}`)
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error'
          segments.push(`## ${path}\n[failed to read: ${message}]`)
        }
      }

      return {
        content: [{ type: 'text' as const, text: segments.join('\n\n') }],
      }
    }
  )
}

/**
 * Create OCR MCP Server. Provides a single tool: `ocr_image`.
 *
 * Usage in session config:
 * ```
 * mcpServers['ocr'] = createOcrMcpServer()
 * ```
 */
export function createOcrMcpServer() {
  return createSdkMcpServer({
    name: 'ocr',
    version: '1.0.0',
    tools: [buildOcrImageTool()],
  })
}
