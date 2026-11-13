import { describe, it, expect } from 'vitest';
import {
  addCacheBreakpoints,
  addSystemPromptCacheBreakpoint,
  limitCacheBreakpoints,
} from './cache-breakpoints.js';

type MarkedBlock = { cache_control?: unknown; [key: string]: unknown };

function markerCount(request: Record<string, unknown>): number {
  const tools = (request.tools ?? []) as MarkedBlock[];
  const system = Array.isArray(request.system) ? request.system as MarkedBlock[] : [];
  const messages = request.messages as Array<Record<string, unknown>>;
  let count = tools.filter((block) => block.cache_control).length
    + system.filter((block) => block.cache_control).length;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    count += (message.content as MarkedBlock[]).filter((block) => block.cache_control).length;
  }
  return count;
}

describe('limitCacheBreakpoints', () => {
  it('leaves a request with four or fewer markers untouched', () => {
    const request = {
      tools: [{ name: 'lookup', cache_control: { type: 'ephemeral' } }],
      system: [
        { type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'dynamic' },
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }] },
        { role: 'assistant', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] },
      ],
    };
    const before = structuredClone(request);

    limitCacheBreakpoints(request);

    expect(request).toEqual(before);
  });

  it('caps markers across tools, system and messages at four', () => {
    const request = {
      tools: [{ name: 'lookup', cache_control: { type: 'ephemeral' } }],
      system: [
        { type: 'text', text: 's0', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 's1', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 's2', cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }] },
      ],
    };

    limitCacheBreakpoints(request);

    expect(markerCount(request)).toBe(4);
    expect(request.tools[0].cache_control).toBeDefined();
    expect(request.system[0].cache_control).toBeUndefined();
    expect(request.system[1].cache_control).toBeDefined();
    expect(request.system[2].cache_control).toBeDefined();
    expect(request.messages[0].content[0].cache_control).toBeDefined();
  });

  it('gives newer message prefixes the remaining slots', () => {
    const request = {
      tools: [{ name: 'lookup', cache_control: { type: 'ephemeral' } }],
      system: [
        { type: 'text', text: 's0', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 's1', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 's2', cache_control: { type: 'ephemeral' } },
      ],
      messages: [0, 1, 2].map((index) => ({
        role: 'user',
        content: [{ type: 'text', text: `m${index}`, cache_control: { type: 'ephemeral' } }],
      })),
    };

    limitCacheBreakpoints(request);

    expect(markerCount(request)).toBe(4);
    expect(request.tools[0].cache_control).toBeDefined();
    expect(request.system[0].cache_control).toBeUndefined();
    expect(request.system[1].cache_control).toBeUndefined();
    expect(request.system[2].cache_control).toBeDefined();
    expect(request.messages.map((message) => message.content[0].cache_control)).toEqual([
      undefined,
      { type: 'ephemeral' },
      { type: 'ephemeral' },
    ]);
  });

  it('preserves block content and does not mutate the caller blocks', () => {
    const first = { type: 'text', text: 's0', cache_control: { type: 'ephemeral' } };
    const request = {
      tools: [{ name: 'lookup', cache_control: { type: 'ephemeral' } }],
      system: [
        first,
        { type: 'text', text: 's1', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 's2', cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }] },
      ],
    };

    limitCacheBreakpoints(request);

    expect(request.system[0]).toEqual({ type: 'text', text: 's0' });
    expect(first.cache_control).toEqual({ type: 'ephemeral' });
    expect(request.messages[0].content[0].text).toBe('hello');
  });

  it('caps a request assembled by the marker helpers', () => {
    const system = addSystemPromptCacheBreakpoint(
      [0, 1, 2, 3, 4].map((index) => ({ type: 'text' as const, text: `s${index}` })),
    );
    const messages = addCacheBreakpoints([{ role: 'user', content: 'hello' }]);
    const request = {
      tools: [{ name: 'lookup', cache_control: { type: 'ephemeral' } }],
      system,
      messages,
    };
    expect(markerCount(request)).toBe(5);

    limitCacheBreakpoints(request);

    expect(markerCount(request)).toBe(4);
  });
});
