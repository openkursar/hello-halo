/**
 * @module tools/mcp/image-result.test
 * Image handling through the public SDK MCP bridge.
 */

import { describe, it, expect } from 'vitest';
import { bridgeSdkMcpTools } from '../../../native/mcp-bridge.js';
import type { ToolContext } from '../../../types/tool.js';

async function format(content: unknown[], isError?: boolean) {
  const [tool] = bridgeSdkMcpTools({ name: 'images', instance: {
    listTools: () => [{ name: 'result', description: '', inputSchema: {} }],
    callTool: async () => ({ content, isError }),
  } });
  return tool.execute({}, { abortSignal: new AbortController().signal } as ToolContext);
}

const fiveMb = 5 * 1024 * 1024;

describe('SDK MCP result image formatting', () => {
  it('keeps text-only results as plain strings', async () => {
    const result = await format([{ type: 'text', text: 'hello' }], false);
    expect(result.content).toBe('hello');
    expect(result.images).toBeUndefined();
    expect(result.isError).toBe(false);
  });

  it('collects image blocks into images with a text placeholder', async () => {
    const result = await format([
      { type: 'text', text: 'chart below' },
      { type: 'image', mimeType: 'image/png', data: 'aGk=' },
    ]);

    expect(result.content).toContain('chart below');
    expect(result.content).toContain('[Image: image/png]');
    expect(result.images).toEqual([{ mimeType: 'image/png', data: 'aGk=' }]);
  });

  it('drops an image over 5 MB with an explanatory note', async () => {
    const result = await format([
      { type: 'image', mimeType: 'image/png', data: Buffer.alloc(fiveMb + 1).toString('base64') },
    ]);

    expect(result.images).toBeUndefined();
    expect(result.content).toContain('exceeds 5 MB');
  });

  it('accepts the same decoded 5 MB limit as Read without a recursive regex', async () => {
    const data = Buffer.alloc(fiveMb).toString('base64');
    const result = await format([{ type: 'image', mimeType: 'image/png', data }]);
    expect(result.images?.[0].data).toBe(data);
  });

  it('drops images beyond 5 in one result', async () => {
    const blocks = Array.from({ length: 7 }, (_, i) => ({
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.from(String(i)).toString('base64'),
    }));
    const result = await format(blocks);

    expect(result.images).toHaveLength(5);
    expect(result.content).toContain('more than 5 images');
  });

  it.each([undefined, 'image/svg+xml', 'application/pdf', '', 42])('rejects missing or unsupported MIME %s', async (mimeType) => {
    const result = await format([{ type: 'image', mimeType, data: 'aGk=' }]);
    expect(result.images).toBeUndefined();
    expect(result.content).toContain('unsupported or missing MIME type');
  });

  it('rejects missing image data without serializing the block', async () => {
    const result = await format([{ type: 'image', mimeType: 'image/png' }]);
    expect(result.images).toBeUndefined();
    expect(result.content).toContain('invalid or missing image data');
  });

  it('rejects malformed base64 with an explicit note', async () => {
    const result = await format([{ type: 'image', mimeType: 'image/png', data: 'not-base64!' }]);
    expect(result.images).toBeUndefined();
    expect(result.content).toContain('invalid base64');
  });
});
