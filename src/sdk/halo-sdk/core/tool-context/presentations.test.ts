import { describe, expect, it } from 'vitest';
import type { Message } from '../../types/provider.js';
import type { Tool, ToolContext } from '../../types/tool.js';
import { fingerprint } from './catalog.js';
import { isToolContextRecord, mergeToolContextRecords, projectToolContextMessages, readToolContextSnapshot } from './history.js';
import { ToolDiscoveryState } from './state.js';
import type { ToolContextRecord, ToolDefinitionSnapshot } from './types.js';

const content = { server: 'crm', identity: 'crm-install', originalName: 'lookup', usageGuide: 'Use account references.',
  definition: { name: 'mcp__crm__lookup', description: 'Read customer orders.', input_schema: { type: 'object' } } };
const definition: ToolDefinitionSnapshot = { ...content, version: fingerprint(content) };
function baseline(discovered = true): Message {
  return { role: 'user', isMeta: true, content: 'Service catalog.', toolContext: { version: 1, baseline: {
    version: 1, generation: 'fixture', discoveryEntries: true, directory: 'Service catalog.',
    definitions: discovered ? [definition] : [], ...(discovered ? {} : { historicalDefinitions: [definition] }),
  } } };
}
function result(): Message {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'search', content: JSON.stringify({ tools: [{
    ...definition.definition, version: definition.version, usage_guide: definition.usageGuide,
  }] }) }], toolContext: { version: 1, presentations: [{ callId: 'search', definitions: [definition.version], guides: [definition.version] }] } };
}

describe('tool presentation metadata', () => {
  it('never grants discovery from an inert historical presentation', () => {
    const messages = [baseline(false), result()];
    expect(readToolContextSnapshot(messages)?.definitions).toEqual([]);
    expect(projectToolContextMessages(messages).every(message => !message.toolContext)).toBe(true);
  });

  it.each(['unknown-version', 'missing-result', 'error-result', 'assistant-result', 'unlisted-guide'] as const)
    ('refuses %s presentation metadata', damage => {
      const shown = result();
      const presentation = shown.toolContext!.presentations![0];
      if (damage === 'unknown-version') { presentation.definitions = ['unknown']; presentation.guides = []; }
      else if (damage === 'missing-result') shown.content = [];
      else if (damage === 'error-result') (shown.content as Array<{ is_error?: boolean }>)[0].is_error = true;
      else if (damage === 'assistant-result') shown.role = 'assistant';
      else presentation.guides = ['unlisted'];
      expect(() => readToolContextSnapshot([baseline(), shown])).toThrow();
    });

  it.each([
    { payloadOffset: 0 }, { payloadLength: 10 }, { payloadOffset: -1, payloadLength: 10 },
    { payloadOffset: 0.5, payloadLength: 10 }, { payloadOffset: 0, payloadLength: 0 },
    { payloadOffset: 0, payloadLength: 100000 },
  ])('refuses an invalid presentation payload span %j', span => {
    const shown = result();
    Object.assign(shown.toolContext!.presentations![0], span);
    expect(() => readToolContextSnapshot([baseline(), shown])).toThrow();
  });

  it('records only the guide that remains after parallel result deduplication', async () => {
    const tools: Tool[] = ['alpha', 'beta'].map(name => ({ name: `mcp__crm__${name}`, description: `${name} record lookup`,
      inputSchema: { type: 'object' }, permissionLevel: 'readonly',
      mcpSource: { server: 'crm', name }, execute: async () => ({ content: 'unused', isError: false }) }));
    const owner = new ToolDiscoveryState(tools, { services: { crm: { identity: 'installed', loading: 'deferred',
      summary: 'Customer records', usageGuide: 'Use account references.' } } }, 32768, 10000);
    const records: ToolContextRecord[] = [];
    const blocks: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];
    for (const name of ['alpha', 'beta']) {
      const found = await owner.searchTool.execute({ query: `select:mcp__crm__${name}` }, { toolUseId: name } as ToolContext);
      const settled = owner.settle(name, found);
      records.push(settled.record!);
      blocks.push({ type: 'tool_result', tool_use_id: name, content: settled.result.content });
    }
    const message: Message = { role: 'user', content: blocks, toolContext: mergeToolContextRecords(records[0], records[1]) };
    expect(message.toolContext?.presentations?.every(item => item.guides.length === 1)).toBe(true);
    owner.finalizeResults(message);
    expect(message.toolContext?.presentations?.map(item => item.guides.length)).toEqual([1, 0]);
    expect(blocks[0].content).toContain('usage_guide');
    expect(blocks[1].content).not.toContain('usage_guide');
    expect(isToolContextRecord(message.toolContext)).toBe(true);
    expect(readToolContextSnapshot([owner.directoryMessage(), message])?.definitions).toHaveLength(2);
  });
});

describe('direct call representation', () => {
  function direct(): Message {
    return { role: 'assistant', content: [{ type: 'tool_use', id: 'direct', name: definition.definition.name, input: {} }],
      toolContext: { version: 1, directCalls: [{ id: 'direct', name: definition.definition.name }] } };
  }
  it('preserves a previously direct call without manufacturing a CallTool wrapper', () => {
    const message = direct();
    expect(readToolContextSnapshot([baseline(), message])?.definitions).toEqual([definition]);
    expect(projectToolContextMessages([message])[0].content).toEqual(message.content);
    expect(mergeToolContextRecords(message.toolContext, result().toolContext)).toMatchObject({
      directCalls: message.toolContext!.directCalls, presentations: result().toolContext!.presentations,
    });
  });
  it.each(['wrong-name', 'missing-block', 'user-role', 'missing-marker', 'duplicate-marker'] as const)
    ('refuses %s direct call metadata', damage => {
      const message = direct();
      if (damage === 'wrong-name') message.toolContext!.directCalls![0].name = 'other';
      else if (damage === 'missing-block') message.content = [];
      else if (damage === 'user-role') message.role = 'user';
      else if (damage === 'missing-marker') delete message.toolContext;
      else message.toolContext!.rejectedCalls = [...message.toolContext!.directCalls!];
      expect(() => readToolContextSnapshot([baseline(), message])).toThrow();
    });
});
