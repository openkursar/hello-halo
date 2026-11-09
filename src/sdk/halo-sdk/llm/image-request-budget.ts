import type { Message, ContentBlock } from '../types/provider.js';
import { getLogger } from '../utils/logger.js';

const MAX_REQUEST_IMAGE_BASE64_CHARS = 20 * 1024 * 1024;
const MAX_IMAGE_REQUEST_BODY_BYTES = 24 * 1024 * 1024;
const log = getLogger('LLM:ImageBudget');

/** Reject oversized image-bearing requests before serialization or network dispatch. */
export function assertImageBodyBudget(body: Record<string, unknown>): void {
  const messages = body.messages;
  if (!Array.isArray(messages)) return;
  let hasImage = false;
  const visit = (value: unknown): void => {
    if (hasImage || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else {
      const record = value as Record<string, unknown>;
      if (record.type === 'image' || record.type === 'image_url') {
        hasImage = true;
      } else {
        for (const item of Object.values(record)) visit(item);
      }
    }
  };
  visit(messages);
  if (!hasImage) return;
  const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  if (bytes > MAX_IMAGE_REQUEST_BODY_BYTES) {
    log.error('Image request exceeds serialized body budget', { bytes, limit: MAX_IMAGE_REQUEST_BODY_BYTES });
    throw new Error(`Image request exceeds ${MAX_IMAGE_REQUEST_BODY_BYTES} bytes after serialization; reduce image size or history before retrying`);
  }
}

export function assertImageRequestBudget(messages: Message[]): void {
  let total = 0;
  let count = 0;
  const visit = (blocks: ContentBlock[]): void => {
    for (const block of blocks) {
      if (block.type === 'image' && block.source.type === 'base64') {
        count++;
        total += block.source.data.length;
      } else if (block.type === 'tool_result' && Array.isArray(block.content)) {
        visit(block.content);
      }
      if (total > MAX_REQUEST_IMAGE_BASE64_CHARS) {
        log.error('Image request exceeds base64 payload budget', {
          imageCount: count,
          base64Chars: total,
          limit: MAX_REQUEST_IMAGE_BASE64_CHARS,
        });
        throw new Error(`Image request exceeds ${MAX_REQUEST_IMAGE_BASE64_CHARS} base64 characters across ${count} images; reduce image size or history before retrying`);
      }
    }
  };
  for (const message of messages) {
    if (Array.isArray(message.content)) visit(message.content);
  }
}
