import { describe, expect, it } from 'vitest';
import type { Tool, ToolContext } from '../../types/tool.js';
import type { ToolDiscoveryOptions } from '../../types/config.js';
import type { Message, ToolUseBlock } from '../../types/provider.js';
import { ToolDiscoveryState, projectToolContextMessages, readToolContextSnapshot, isToolContextRecord } from './index.js';

const policy: ToolDiscoveryOptions = { services: {
  crm: { identity: 'installation:customer', loading: 'deferred', summary: '客户订单与跟进记录', usageGuide: 'Use customer IDs from the selected workspace.' },
} };
function tool(name = 'orders', description = '查询客户订单'): Tool {
  return { name: `mcp__crm__${name}`, description,
    mcpSource: { server: 'crm', name, toolDescription: description },
    inputSchema: { type: 'object', properties: { customer: { type: 'string' } }, required: ['customer'] },
    permissionLevel: 'readonly', execute: async () => ({ content: 'ok', isError: false }) };
}
function state(tools: Tool[] = [tool()], resultCharacters = 32768, recoveryTokens = 50000) {
  return new ToolDiscoveryState(tools, policy, resultCharacters, recoveryTokens);
}
function call(name: string, args: Record<string, unknown>): ToolUseBlock {
  return { type: 'tool_use', id: 'execute', name, input: args };
}
async function search(owner: ToolDiscoveryState, id = 'search', query = '客户订单') {
  const result = await owner.searchTool.execute({ query }, { toolUseId: id } as ToolContext);
  return owner.settle(id, result);
}

describe('client tool discovery', () => {
  it('keeps schemas fixed while definitions are committed behind ordinary results', async () => {
    const owner = state([tool(), tool('notes', '客户跟进记录')]);
    const before = JSON.stringify(owner.modelDefinitions);
    expect(owner.modelDefinitions.map(item => item.name)).toEqual(['ToolSearch', 'CallTool']);
    expect(before).not.toContain('mcp__crm__orders');
    const found = await search(owner);
    expect(found.result.content).toContain('input_schema');
    expect(found.record?.discoveries?.[0].definitions.length).toBeGreaterThan(0);
    expect(owner.normalize(call('CallTool', { tool: tool().name, arguments: '{"customer":"1"}' })).error).toMatch(/not been discovered/);
    owner.commit(found.record!);
    expect(owner.normalize(call('CallTool', { tool: tool().name, arguments: '{"customer":"1"}' })).call.name).toBe(tool().name);
    expect(JSON.stringify(owner.modelDefinitions)).toBe(before);
  });

  it('never discovers tools not in the selected execution pool', async () => {
    const owner = state([]);
    expect(owner.enabled).toBe(false);
    expect(owner.modelDefinitions).toEqual([]);
    expect(owner.catalog.directory).toBe('');
    expect((await search(owner)).result.content).toContain('No matching tools');
  });

  it('retains native and unclassified tools as eager without inferring source from names', () => {
    const ordinary = { ...tool(), mcpSource: undefined };
    const owner = state([ordinary]);
    expect(owner.enabled).toBe(false);
    expect(owner.modelDefinitions[0].name).toBe(ordinary.name);
  });

  it('does not reserve or reinterpret ordinary CallTool when no discovery entries are needed', () => {
    const ordinary = { ...tool(), name: 'CallTool', mcpSource: undefined };
    const owner = state([ordinary]);
    const direct = call('CallTool', { customer: '42' });
    expect(owner.normalize(direct)).toEqual({ call: direct });
    expect(owner.snapshot().discoveryEntries).toBe(false);
    expect(owner.recoveryMessage().content).toBe('');
  });

  it('lets the host make a service eager with a deferred tool override', () => {
    const owner = new ToolDiscoveryState([tool(), tool('notes')], {
      services: { crm: { identity: 'customer', loading: 'eager', toolOverrides: { orders: 'deferred' } } },
    }, 32768, 50000);
    expect(owner.modelDefinitions.map(item => item.name)).toEqual(['mcp__crm__notes', 'ToolSearch', 'CallTool']);
  });

  it('rejects name collisions and explicitly disabled discovery entries', () => {
    expect(() => state([tool(), tool()])).toThrow(/Duplicate/);
    expect(() => state([tool(), { ...tool(), name: 'CallTool', mcpSource: undefined }])).toThrow(/reserved/);
    expect(() => new ToolDiscoveryState([tool()], policy, 32768, 50000, ['ToolSearch'])).toThrow(/disabled/);
    expect(() => new ToolDiscoveryState([], policy, 32768, 50000, ['ToolSearch'])).not.toThrow();
  });

  it.each(['null', '[]', '1', '"text"', '{'])('rejects wrapped arguments %s', async argumentsJson => {
    const owner = state();
    owner.commit((await search(owner)).record!);
    expect(owner.normalize(call('CallTool', { tool: tool().name, arguments: argumentsJson })).error).toBeTruthy();
  });

  it('rejects extra wrapper fields, eager wrappers and direct deferred calls', () => {
    const owner = state();
    expect(owner.normalize(call('CallTool', { tool: 'Read', arguments: '{}' })).error).toMatch(/unavailable/);
    expect(owner.normalize(call('CallTool', { tool: tool().name, arguments: '{}', extra: true })).error).toMatch(/exactly/);
    expect(owner.normalize(call(tool().name, { customer: '1' })).error).toMatch(/direct/);
  });

  it('preserves the original string for model history and the parsed object for execution', async () => {
    const owner = state();
    owner.commit((await search(owner)).record!);
    const raw = '{ "customer" : "42" }';
    const normalized = owner.normalize(call('CallTool', { tool: tool().name, arguments: raw }));
    expect(normalized.call.input).toEqual({ customer: '42' });
    const history: Message = { role: 'assistant', content: [normalized.call],
      toolContext: { version: 1, calls: [normalized.origin!] } };
    const projected = projectToolContextMessages([history])[0];
    expect(projected).not.toHaveProperty('toolContext');
    expect(projected.content).toEqual([call('CallTool', { tool: tool().name, arguments: raw })]);
    expect(history.content).toEqual([normalized.call]);
  });

  it('repeats only a reference unless the model explicitly requests the full definition', async () => {
    const owner = state();
    owner.commit((await search(owner)).record!);
    const repeated = await search(owner, 'repeat');
    expect(repeated.result.content).toContain('already_loaded');
    expect(repeated.record).toBeUndefined();
    const exact = await search(owner, 'exact', `select:${tool().name}`);
    expect(exact.result.content).toContain('input_schema');
    expect(exact.record?.discoveries).toBeUndefined();
    expect(exact.record?.presentations).toEqual([{ callId: 'exact', definitions: [owner.snapshot().definitions[0].version], guides: [] }]);
  });

  it('delivers each service guide once and restores it independently of model summaries', async () => {
    const owner = state([tool(), tool('notes')]);
    const first = await search(owner, 'one', 'select:mcp__crm__orders');
    owner.commit(first.record!);
    const next = await search(owner, 'two', 'select:mcp__crm__notes');
    expect(next.result.content).not.toContain('usage_guide');
    owner.commit(next.record!);
    expect(String(owner.recoveryMessage().content).match(/Use customer IDs/g)).toHaveLength(1);
  });

  it('does not load a definition cut off by either result or recovery budgets', async () => {
    const owner = state([tool('large', '查询客户订单' + 'x'.repeat(40000))]);
    const found = await search(owner);
    expect(found.result.content).toContain('did not fit');
    expect(found.record).toBeUndefined();
    const tooSmall = state([tool()], 32768, 5);
    expect((await search(tooSmall)).record).toBeUndefined();
  });

  it('does not commit a post-hook replacement or truncated result', async () => {
    const owner = state();
    await owner.searchTool.execute({ query: '客户订单' }, { toolUseId: 'changed' } as ToolContext);
    const settled = owner.settle('changed', { content: 'replacement', isError: false });
    expect(settled.result.isError).toBe(true);
    expect(settled.record).toBeUndefined();
    expect(owner.snapshot().definitions).toEqual([]);
  });

  it('ignores third-party metadata when no internal search result owns the call ID', () => {
    const owner = state();
    const settled = owner.settle('fake', { content: 'ok', isError: false, metadata: { discoveries: [tool()] } });
    expect(settled.record).toBeUndefined();
  });

  it('restores only allowed exact versions and keeps instances independent', async () => {
    const parent = state();
    parent.commit((await search(parent)).record!);
    const child = state();
    expect(child.snapshot().definitions).toEqual([]);
    child.restore(parent.snapshot());
    child.clear();
    expect(parent.snapshot().definitions).toHaveLength(1);
    const changed = state([tool('orders', 'changed schema description')]);
    changed.restore(parent.snapshot());
    expect(changed.snapshot().definitions).toEqual([]);
    const removed = state([]);
    removed.restore(parent.snapshot());
    expect(removed.snapshot().definitions).toEqual([]);
  });

  it('reads structured deltas at history boundaries and refuses missing or corrupt state', async () => {
    const owner = state();
    const baseline = owner.directoryMessage();
    const found = await search(owner);
    const result: Message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'search', content: found.result.content }],
      toolContext: found.record };
    expect(readToolContextSnapshot([baseline])?.definitions).toEqual([]);
    expect(readToolContextSnapshot([baseline, result])?.definitions).toHaveLength(1);
    expect(() => readToolContextSnapshot([result])).toThrow(/missing its baseline/);
    const broken = structuredClone(found.record!);
    broken.discoveries![0].definitions[0].definition.description = 'tampered';
    expect(isToolContextRecord(broken)).toBe(false);
    expect(readToolContextSnapshot([{ role: 'user', content: JSON.stringify(found.record) }])).toBeUndefined();
  });
});
