/**
 * @module core/image-media-type
 * Labels base64 images with the format their bytes actually have. Providers
 * reject an image whose declared media type disagrees with its content, and
 * a mislabeled image stays in the history, failing every later request.
 * @license MIT
 */

import type { ContentBlock, ImageBlock, Message } from '../types/provider.js';

/** The image format of base64 data from its leading bytes, if it is one providers accept. */
export function sniffImageMediaType(base64: string): string | undefined {
  if (typeof base64 !== 'string' || base64.length < 16) return undefined;
  const head = Buffer.from(base64.slice(0, 24), 'base64');
  if (head.length >= 8 && head[0] === 0x89 && head.toString('latin1', 1, 4) === 'PNG' &&
      head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.toString('latin1', 0, 6))) return 'image/gif';
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

function correctedImage(block: ImageBlock): ImageBlock | undefined {
  if (block.source?.type !== 'base64') return undefined;
  const actual = sniffImageMediaType(block.source.data);
  return actual && actual !== block.source.media_type
    ? { ...block, source: { ...block.source, media_type: actual } }
    : undefined;
}

/** Corrected copies of the blocks, or undefined when none needed it. */
function correctBlocks(blocks: ContentBlock[], fixed: { count: number }): ContentBlock[] | undefined {
  let changed: ContentBlock[] | undefined;
  blocks.forEach((block, index) => {
    let replacement: ContentBlock | undefined;
    if (block.type === 'image') {
      replacement = correctedImage(block);
      if (replacement) fixed.count++;
    } else if (block.type === 'tool_result' && Array.isArray(block.content)) {
      const content = correctBlocks(block.content, fixed);
      if (content) replacement = { ...block, content };
    }
    if (replacement) {
      changed ??= [...blocks];
      changed[index] = replacement;
    }
  });
  return changed;
}

/**
 * Relabel mislabeled images in place, including those inside tool results.
 * Messages that need no change keep their identity. Returns how many images
 * were relabeled.
 */
export function correctImageMediaTypes(messages: Message[]): number {
  const fixed = { count: 0 };
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (typeof message.content === 'string') continue;
    const content = correctBlocks(message.content, fixed);
    if (content) messages[index] = { ...message, content };
  }
  return fixed.count;
}
