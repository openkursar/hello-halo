import { describe, expect, it } from 'vitest';
import { createToolContext, ToolContextCache } from './tool-context.js';
import type { NativeHandle } from './binding.js';

describe('native tool context identity', () => {
  it('keeps the original tool ID visible while routing identical IDs to their owning child', async () => {
    const calls: unknown[] = [];
    const emitted: unknown[] = [];
    const owners: unknown[] = [];
    const handle = {
      contextCall: (id: string, method: string) => { calls.push([id, method]); return '7'; },
      contextEmit: async (id: string, event: string) => { emitted.push([id, JSON.parse(event)]); },
      sharedContext: (id: string, owner: string) => { owners.push(owner); return { runId: JSON.parse(id)[0], readIdentity: JSON.parse(id)[0],
        catalogOwner: JSON.parse(id)[0], catalogScope: '', skills: { snapshot: () => '[]' },
        cost: { call: (method: string) => { calls.push([id, `costTracker.${method}`]); return '7'; } },
        reads: { call: () => 'null' },
      }; },
    } as unknown as NativeHandle;
    const signal = new AbortController().signal;
    const cache = new ToolContextCache();
    const first = createToolContext(handle, { sessionId: 'first', toolUseId: 'same', nativeContextId: '["first","same"]', nativeCatalogOwner: 'first-owner', cwd: '/fixture', currentTurn: 1, env: {} }, signal, cache);
    const second = createToolContext(handle, { sessionId: 'second', toolUseId: 'same', nativeContextId: '["second","same"]', nativeCatalogOwner: 'second-owner', cwd: '/fixture', currentTurn: 1, env: {} }, signal, cache);
    const sameOwner = createToolContext(handle, { sessionId: 'first', toolUseId: 'next', nativeContextId: '["first","next"]', nativeCatalogOwner: 'first-owner', cwd: '/fixture', currentTurn: 1, env: {} }, signal, cache);
    expect(sameOwner.costTracker).toBe(first.costTracker); expect(sameOwner.readFileState).toBe(first.readFileState);
    expect(second.costTracker).not.toBe(first.costTracker); expect(second.readFileState).not.toBe(first.readFileState);
    expect(first.toolUseId).toBe('same');
    expect(second.toolUseId).toBe('same');
    expect('nativeContextId' in first).toBe(false);
    expect('nativeCatalogOwner' in first).toBe(false);
    expect(owners).toEqual(['first-owner', 'second-owner', 'first-owner']);
    expect(first.costTracker.totalTokens).toBe(7);
    expect(second.costTracker.totalTokens).toBe(7);
    await second.onToolMessage?.({ type: 'system', subtype: 'fixture' });
    expect(calls).toEqual([['["first","same"]', 'costTracker.totalTokens'], ['["second","same"]', 'costTracker.totalTokens']]);
    expect(emitted).toEqual([['["second","same"]', { type: 'system', subtype: 'fixture' }]]);
  });
});
