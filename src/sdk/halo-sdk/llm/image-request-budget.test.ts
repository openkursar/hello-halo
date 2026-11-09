import { describe, expect, it } from 'vitest';
import { assertImageBodyBudget, assertImageRequestBudget } from './image-request-budget.js';
import type { Message } from '../types/provider.js';

const image = (length: number) => ({
  type: 'image' as const,
  source: { type: 'base64' as const, media_type: 'image/png', data: 'A'.repeat(length) },
});

describe('image request budget', () => {
  it('rejects several individually valid images across multiple tool results', () => {
    const messages: Message[] = Array.from({ length: 2 }, (_, index) => ({
      role: 'user' as const,
      content: [{ type: 'tool_result' as const, tool_use_id: `shot_${index}`, content: Array.from({ length: 5 }, () => image(3 * 1024 * 1024)) }],
    }));
    expect(() => assertImageRequestBudget(messages)).toThrow(/Image request exceeds/);
  });

  it('rejects a large image-bearing serialized request even with small image data', () => {
    expect(() => assertImageBodyBudget({
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } }] }],
      system: 'x'.repeat(24 * 1024 * 1024),
    })).toThrow(/bytes after serialization/);
  });

  it('counts top-level images and accepts requests below the image budget', () => {
    expect(() => assertImageRequestBudget([{ role: 'user', content: [image(1024)] }])).not.toThrow();
  });
});
