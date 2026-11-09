/**
 * @module tools/mcp/image-result.test
 * Unit tests for image handling in the two formatCallToolResult copies.
 */

import { describe, it, expect } from 'vitest';
import { formatCallToolResult as fromBridge } from './bridge.js';
import { formatCallToolResult as fromConnectionManager } from './connection-manager.js';

const fiveMb = 5 * 1024 * 1024;

describe.each([
  ['bridge', fromBridge],
  ['connection-manager', fromConnectionManager],
])('formatCallToolResult (%s)', (_label, format) => {
  it('keeps text-only results as plain strings', () => {
    const result = format([{ type: 'text', text: 'hello' }], false);
    expect(result.content).toBe('hello');
    expect(result.images).toBeUndefined();
    expect(result.isError).toBe(false);
  });

  it('collects image blocks into images with a text placeholder', () => {
    const result = format([
      { type: 'text', text: 'chart below' },
      { type: 'image', mimeType: 'image/png', data: 'aGk=' },
    ]);

    expect(result.content).toContain('chart below');
    expect(result.content).toContain('[Image: image/png]');
    expect(result.images).toEqual([{ mimeType: 'image/png', data: 'aGk=' }]);
  });

  it('drops an image over 5 MB with an explanatory note', () => {
    const result = format([
      { type: 'image', mimeType: 'image/png', data: Buffer.alloc(fiveMb + 1).toString('base64') },
    ]);

    expect(result.images).toBeUndefined();
    expect(result.content).toContain('exceeds 5 MB');
  });

  it('accepts the same decoded 5 MB limit as Read without a recursive regex', () => {
    const data = Buffer.alloc(fiveMb).toString('base64');
    const result = format([{ type: 'image', mimeType: 'image/png', data }]);
    expect(result.images?.[0].data).toBe(data);
  });

  it('drops images beyond 5 in one result', () => {
    const blocks = Array.from({ length: 7 }, (_, i) => ({
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.from(String(i)).toString('base64'),
    }));
    const result = format(blocks);

    expect(result.images).toHaveLength(5);
    expect(result.content).toContain('more than 5 images');
  });

  it.each([undefined, 'image/svg+xml', 'application/pdf', '', 42])('rejects missing or unsupported MIME %s', (mimeType) => {
    const result = format([{ type: 'image', mimeType, data: 'aGk=' }]);
    expect(result.images).toBeUndefined();
    expect(result.content).toContain('unsupported or missing MIME type');
  });

  it('rejects missing image data without serializing the block', () => {
    const result = format([{ type: 'image', mimeType: 'image/png' }]);
    expect(result.images).toBeUndefined();
    expect(result.content).toContain('invalid or missing image data');
  });

  it('rejects malformed base64 with an explicit note', () => {
    const result = format([{ type: 'image', mimeType: 'image/png', data: 'not-base64!' }]);
    expect(result.images).toBeUndefined();
    expect(result.content).toContain('invalid base64');
  });
});
