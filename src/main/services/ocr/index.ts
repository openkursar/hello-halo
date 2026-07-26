/**
 * OCR service — shared on-device text-from-image capability.
 *
 * - engine: lazy tesseract.js worker (ocrImage / shutdownOcr)
 * - mcp-server: the `ocr_image` MCP tool for chat toolset + automation runtime
 */

export { ocrImage, shutdownOcr } from './engine'
export { createOcrMcpServer } from './mcp-server'
