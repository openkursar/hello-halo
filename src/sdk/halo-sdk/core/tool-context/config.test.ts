import { describe, expect, it } from 'vitest';
import { snapshotToolDiscoveryOptions } from './config.js';
import { ToolDiscoveryState, TOOL_CONTEXT_LIMITS } from './index.js';
import type { ToolDiscoveryOptions } from '../../types/config.js';
import type { Tool, ToolContext } from '../../types/tool.js';

describe('tool discovery configuration', () => {
  it.each([null, [], {}, { services: [] }, { services: { crm: {} } },
    { services: { crm: { identity: 'crm', loading: 'automatic' } } },
    { services: { crm: { identity: '', loading: 'deferred' } } },
    { services: { crm: { identity: 'crm', loading: 'deferred', toolOverrides: { lookup: 'automatic' } } } },
    { services: { crm: { identity: 'crm', loading: 'deferred', summary: false } } },
  ])('rejects an invalid policy without silently changing mode: %j', value => {
    expect(() => snapshotToolDiscoveryOptions(value as ToolDiscoveryOptions)).toThrow(TypeError);
  });

  it('snapshots policies so subsequent caller mutations cannot change a context', () => {
    const input: ToolDiscoveryOptions = { services: { crm: { identity: 'crm', loading: 'deferred',
      toolOverrides: { lookup: 'eager' } } } };
    const captured = snapshotToolDiscoveryOptions(input)!;
    input.services.crm.loading = 'eager';
    input.services.crm.toolOverrides!.lookup = 'deferred';
    expect(captured.services.crm).toEqual({ identity: 'crm', loading: 'deferred', toolOverrides: { lookup: 'eager' } });
    expect(snapshotToolDiscoveryOptions(undefined)).toBeUndefined();
  });

  it('bounds the extra catalog rather than cloning an arbitrarily large server definition', () => {
    const tool: Tool = { name: 'mcp__large__tool', description: 'x'.repeat(TOOL_CONTEXT_LIMITS.catalogBytes),
      mcpSource: { server: 'large', name: 'tool' }, inputSchema: { type: 'object' },
      permissionLevel: 'none', execute: async () => ({ content: '', isError: false }) };
    expect(() => new ToolDiscoveryState([tool], { services: { large: { identity: 'large', loading: 'deferred' } } },
      32768, 100000)).toThrow(/definition limit/);
  });

  it('rejects oversized queries before indexing their text and counts Unicode characters', async () => {
    const state = new ToolDiscoveryState([], { services: {} }, 32768, 100000);
    const query = (value: string, id: string) => state.searchTool.execute({ query: value }, { toolUseId: id } as ToolContext);
    expect((await query('🧩'.repeat(TOOL_CONTEXT_LIMITS.queryCharacters), 'limit')).isError).toBe(false);
    const rejected = await query('🧩'.repeat(TOOL_CONTEXT_LIMITS.queryCharacters + 1), 'too-long');
    expect(rejected.isError).toBe(true);
    expect(rejected.content).toContain('Use a shorter purpose');
    expect(state.snapshot().definitions).toEqual([]);
  });
});
