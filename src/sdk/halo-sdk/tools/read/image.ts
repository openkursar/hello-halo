/**
 * @module tools/read/image
 * Image file reader with size pre-validation, returning base64 for the model.
 * @license MIT
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ToolResultImage } from '../../types/tool.js';
import { readBounded } from '../../utils/bounded-read.js';
import { MAX_IMAGE_BYTES } from '../../utils/image-data.js';

/** Extensions the vision-capable providers accept as base64 image blocks. */
const BASE64_IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * Read an image file and return its base64 payload for the model, plus a
 * short text placeholder describing the file. Vector and icon formats with no
 * base64 wire representation come back as text only. Throws on files larger
 * than 5 MB to avoid wasting API round-trips on oversized media.
 */
export async function readImage(filePath: string): Promise<{
  text: string;
  image?: ToolResultImage;
}> {
  const stat = await fs.stat(filePath);

  if (stat.size > MAX_IMAGE_BYTES) {
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
    throw new Error(
      `Image file is too large (${sizeMB} MB). Maximum supported size is ${MAX_IMAGE_BYTES / (1024 * 1024)} MB. ` +
      `Consider resizing or compressing the image before reading.`,
    );
  }

  const ext = path.extname(filePath).toLowerCase().slice(1);
  const mimeType = BASE64_IMAGE_MIME[ext];

  const text = `[Image file: ${filePath}. The image content has been captured for visual analysis.]`;
  if (!mimeType) {
    return { text: `[Image file: ${filePath}. This format cannot be delivered for visual analysis; convert it to PNG, JPEG, GIF, or WebP.]` };
  }

  const handle = await fs.open(filePath, 'r');
  try {
    const data = await readBounded(handle, MAX_IMAGE_BYTES);
    return { text, image: { mimeType, data: data.toString('base64') } };
  } finally {
    await handle.close();
  }
}
