import { describe, expect, it } from 'vitest';
import type { Message, ToolResultBlock } from '../../types/provider.js';
import type { Tool, ToolContext } from '../../types/tool.js';
import { mergeToolContextRecords, readToolContextSnapshot } from './history.js';
import { ToolDiscoveryState } from './state.js';

const definition: Tool = {
  name: 'mcp__crm__lookup', description: 'Look up customer records.',
  mcpSource: { server: 'crm', name: 'lookup' },
  inputSchema: { type: 'object', properties: { account: { type: 'string' } }, required: ['account'] },
  permissionLevel: 'readonly', execute: async () => ({ content: 'unused', isError: false }),
};
const guide = 'Use the account reference.';
function state() {
  return new ToolDiscoveryState([definition], { services: { crm: {
    identity: 'fixture', loading: 'deferred', summary: 'Customer records', usageGuide: guide,
  } } }, 32768, 10000);
}
async function search(owner: ToolDiscoveryState, id: string, explicit: boolean, rejected = false) {
  const found = await owner.searchTool.execute({ query: explicit ? `select:${definition.name}` : 'lookup' }, { toolUseId: id } as ToolContext);
  const settled = owner.settle(id, rejected ? { content: 'Replaced by the output hook.', isError: false } : found);
  const block: ToolResultBlock = { type: 'tool_result', tool_use_id: id, content: settled.result.content, is_error: settled.result.isError };
  return { block, record: settled.record };
}

describe('parallel tool discovery finalization', () => {
  it('does not grant from completed search output whose post-hook settlement was interrupted', async () => {
    const owner = state();
    const found = await owner.searchTool.execute({ query: 'lookup' }, { toolUseId: 'unsettled' } as ToolContext);
    const message: Message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'unsettled', content: found.content }] };
    owner.finalizeResults(message);
    expect(message.toolContext).toBeUndefined();
    expect(owner.snapshot().definitions).toEqual([]);
    expect(message.content).toEqual([{ type: 'tool_result', tool_use_id: 'unsettled', is_error: true,
      content: expect.stringContaining('No new definitions were loaded') }]);
    expect(JSON.stringify(message.content)).not.toContain('input_schema');
  });

  it('bounds an interrupted search error by the configured result budget', async () => {
    const owner = new ToolDiscoveryState([definition], { services: { crm: {
      identity: 'fixture', loading: 'deferred', summary: 'Customer records',
    } } }, 100, 10000);
    const found = await owner.searchTool.execute({ query: 'unknown-capability' }, { toolUseId: 'unsettled' } as ToolContext);
    expect(owner.hasSearchResult('unsettled')).toBe(true);
    const message: Message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'unsettled', content: found.content }] };
    owner.finalizeResults(message);
    const block = (message.content as ToolResultBlock[])[0];
    expect(block.is_error).toBe(true);
    expect(String(block.content).length).toBeLessThanOrEqual(100);
    expect(String(block.content).length).toBeLessThanOrEqual(found.content.length);
    expect(message.toolContext).toBeUndefined();
    expect(owner.snapshot().definitions).toEqual([]);
  });

  for (const explicit of [false, true]) for (const rejected of [false, true]) {
    it(`commits a version once for explicit=${explicit}, first-hook-rejected=${rejected}`, async () => {
      const owner = state();
      const baseline = owner.directoryMessage();
      const first = await search(owner, 'first', explicit, rejected);
      const second = await search(owner, 'second', explicit);
      const message: Message = { role: 'user', content: [first.block, second.block],
        toolContext: mergeToolContextRecords(first.record, second.record) };
      const initialSizes = [first.block, second.block].map(block => ({ characters: String(block.content).length,
        bytes: Buffer.byteLength(String(block.content), 'utf8') }));
      owner.finalizeResults(message);
      expect(owner.snapshot().definitions).toEqual([]);
      expect(message.toolContext?.discoveries).toHaveLength(1);
      expect(message.toolContext?.discoveries?.[0].callId).toBe(rejected ? 'second' : 'first');
      expect(message.toolContext?.discoveries?.[0].definitions).toHaveLength(1);
      const shown = JSON.parse(String(second.block.content)).tools[0];
      if (explicit || rejected) expect(shown.input_schema).toEqual(definition.inputSchema);
      else {
        expect(shown).toMatchObject({ name: definition.name, already_loaded: true });
        expect(shown).not.toHaveProperty('input_schema');
      }
      expect(message.toolContext?.presentations).toHaveLength(!rejected && explicit ? 2 : 1);
      expect(message.toolContext?.presentations?.flatMap(item => item.guides)).toHaveLength(1);
      expect(message.content.map(block => JSON.stringify(block)).join('\n').split(guide)).toHaveLength(2);
      for (const [index, block] of [first.block, second.block].entries()) {
        expect(String(block.content).length).toBeLessThanOrEqual(initialSizes[index].characters);
        expect(Buffer.byteLength(String(block.content), 'utf8')).toBeLessThanOrEqual(initialSizes[index].bytes);
      }
      expect(readToolContextSnapshot([baseline, message])?.definitions).toHaveLength(1);
      const prepared = structuredClone(message);
      owner.finalizeResults(message);
      expect(message).toEqual(prepared);
      owner.commit(message.toolContext!);
      expect(owner.snapshot().definitions).toHaveLength(1);
      const later = await search(owner, 'later', false);
      expect(later.record).toBeUndefined();
      expect(String(later.block.content)).toContain('already_loaded');
    });
  }

  it('assigns discovery to the first delivered result, independently of completion order', async () => {
    const owner = state();
    const first = await search(owner, 'completed-first', false);
    const second = await search(owner, 'completed-second', false);
    const message: Message = { role: 'user', content: [second.block, first.block],
      toolContext: mergeToolContextRecords(first.record, second.record) };
    owner.finalizeResults(message);
    expect(message.toolContext?.discoveries?.map(item => item.callId)).toEqual(['completed-second']);
    expect(message.toolContext?.presentations?.map(item => item.callId)).toEqual(['completed-second']);
    expect(JSON.parse(String(first.block.content)).tools[0].already_loaded).toBe(true);
  });
});
