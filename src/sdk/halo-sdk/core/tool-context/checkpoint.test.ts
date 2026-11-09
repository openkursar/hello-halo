import { describe, expect, it, vi } from 'vitest';
import type { LlmProvider, Message } from '../../types/provider.js';
import { fullCompact } from '../compact.js';
import { estimateMessageTokens } from '../../utils/tokens.js';
import { fingerprint } from './catalog.js';
import { prepareToolContextCheckpoint } from './checkpoint.js';
import { readToolContextSnapshot } from './history.js';
import type { ToolContextSnapshot, ToolDefinitionSnapshot } from './types.js';

const guide = 'Use the account reference, not the display name, when reading records.';
const directory = 'Available services: customer records.';
function definition(name: string): ToolDefinitionSnapshot {
  const content = { server: 'crm', identity: 'installed-crm', originalName: name, usageGuide: guide,
    definition: { name: `mcp__crm__${name}`, description: `${name} complete definition.`,
      input_schema: { type: 'object', properties: { account: { type: 'string' } }, required: ['account'], additionalProperties: false } } };
  return { ...content, version: fingerprint(content) };
}
const alpha = definition('alpha');
const beta = definition('beta');
function snapshot(definitions: ToolDefinitionSnapshot[], generation = 'current'): ToolContextSnapshot {
  return { version: 1, generation, discoveryEntries: true, directory, definitions };
}
function baseline(state: ToolContextSnapshot): Message {
  return { role: 'user', isMeta: true, content: state.directory + '\n' + JSON.stringify(state.definitions.map(item => ({
    ...item.definition, version: item.version, usage_guide: item.usageGuide,
  }))), toolContext: { version: 1, baseline: state, baselineAttachment: true } };
}
function discovery(item: ToolDefinitionSnapshot, includeGuide = true): Message[] {
  const id = `search-${item.originalName}`;
  return [
    { role: 'assistant', content: [{ type: 'tool_use', name: 'ToolSearch', id, input: { query: `select:${item.definition.name}` } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify({ tools: [{
      ...item.definition, version: item.version, ...(includeGuide ? { usage_guide: item.usageGuide } : {}),
    }] }) }], toolContext: { version: 1, discoveries: [{ callId: id, definitions: [item] }],
      presentations: [{ callId: id, definitions: [item.version], guides: includeGuide ? [item.version] : [] }] } },
  ];
}
function call(item: ToolDefinitionSnapshot): Message[] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: item.definition.name, input: { account: '42' } }],
      toolContext: { version: 1, calls: [{ id: 'call', definitionVersion: item.version,
        input: { tool: item.definition.name, arguments: '{ "account": "42" }' } }] } },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'Receipt 42.' }] },
  ];
}
const visible = (messages: readonly Message[]) => messages.map(message =>
  typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
const longWork = (count: number): Message[] => Array.from({ length: count }, (_, index) => ({
  role: index % 2 ? 'assistant' : 'user', content: `Earlier work ${index}: ${'evidence '.repeat(700)}`,
}));
const summaryProvider = () => ({ createMessage: vi.fn(async () => ({ id: 'summary', model: 'fixture',
  content: [{ type: 'text', text: 'Continue the requested work with the verified constraints.' }], stopReason: 'end_turn',
  usage: { input_tokens: 100, output_tokens: 12 } })) } as unknown as LlmProvider);

describe('tool context checkpoint reconciliation', () => {
  it('keeps one current snapshot when a retained tail contains an older baseline', () => {
    const old = baseline(snapshot([alpha], 'previous'));
    const found = discovery(beta);
    const source = [old, ...found];
    const current = snapshot([alpha, beta]);
    const candidate = [baseline(current), ...source];
    const before = structuredClone(candidate);
    const prepared = prepareToolContextCheckpoint(candidate, source, current);
    expect(prepared.filter(message => message.toolContext?.baseline)).toHaveLength(1);
    expect(prepared.slice(1)).toEqual(found);
    expect(readToolContextSnapshot(prepared)?.definitions).toEqual([alpha, beta]);
    expect(visible(prepared).split(alpha.definition.description)).toHaveLength(2);
    expect(visible(prepared).split(beta.definition.description)).toHaveLength(2);
    expect(visible(prepared).split(guide)).toHaveLength(2);
    expect(candidate).toEqual(before);
    expect(prepareToolContextCheckpoint(prepared, prepared, current)).toEqual(prepared);
  });

  it('restores a missing shared guide without repeating complete definitions already in the retained results', () => {
    const current = snapshot([alpha, beta]);
    const retained = [...discovery(alpha, false), ...discovery(beta, false)];
    const prepared = prepareToolContextCheckpoint([baseline(current), ...retained], retained, current);
    expect(prepared[0].content).toContain('Service usage guides:');
    expect(prepared[0].content).not.toContain(alpha.definition.description);
    expect(prepared[0].content).not.toContain(beta.definition.description);
    expect(visible(prepared).split(guide)).toHaveLength(2);
    expect(readToolContextSnapshot(prepared)?.definitions).toEqual([alpha, beta]);
    expect(prepareToolContextCheckpoint(prepared, prepared, current)).toEqual(prepared);
  });

  it('deduplicates explicit re-displays without creating a second discovery event', () => {
    const current = snapshot([alpha]);
    const retained = discovery(alpha);
    delete retained[1].toolContext!.discoveries;
    const prepared = prepareToolContextCheckpoint([baseline(current), ...retained], retained, current);
    expect(prepared[0].content).toBe(directory);
    expect(readToolContextSnapshot(prepared)?.definitions).toEqual([alpha]);
    expect(prepared.some(message => message.toolContext?.discoveries)).toBe(false);
    expect(visible(prepared).split(alpha.definition.description)).toHaveLength(2);
    expect(prepareToolContextCheckpoint(prepared, prepared, current)).toEqual(prepared);
  });

  it('verifies a recorded JSON span without interpreting surrounding host context as definitions', () => {
    const current = snapshot([alpha]);
    const retained = discovery(alpha);
    const block = (retained[1].content as Array<{ content: string }>)[0];
    const payload = block.content;
    const prefix = 'Host note 中文: ' + JSON.stringify({ tools: [{ ...beta.definition, version: beta.version }] }) + '\n\n';
    block.content = prefix + payload + '\n\nHost suffix.';
    Object.assign(retained[1].toolContext!.presentations![0], { payloadOffset: prefix.length, payloadLength: payload.length });
    const prepared = prepareToolContextCheckpoint([baseline(current), ...retained], retained, current);
    expect(prepared[0].content).toBe(directory);
    expect(prepared.slice(1)).toEqual(retained);
    expect(readToolContextSnapshot(prepared)?.definitions).toEqual([alpha]);
    expect(prepareToolContextCheckpoint(prepared, prepared, current)).toEqual(prepared);
  });

  it('restores a definition when a recorded span does not contain its complete schema', () => {
    const current = snapshot([alpha]);
    const retained = discovery(alpha);
    const block = (retained[1].content as Array<{ content: string }>)[0];
    const context = JSON.stringify({ tools: [] });
    block.content = context + '\n\n' + block.content;
    Object.assign(retained[1].toolContext!.presentations![0], { payloadOffset: 0, payloadLength: context.length });
    const prepared = prepareToolContextCheckpoint([baseline(current), ...retained], retained, current);
    expect(prepared[0].content).toContain(alpha.definition.description);
    expect(readToolContextSnapshot(prepared)?.definitions).toEqual([alpha]);
  });

  it('preserves an earlier eager call when the retained snapshot now discovers the same tool', () => {
    const eager: Message = { role: 'assistant', content: [{ type: 'tool_use', id: 'eager-call',
      name: alpha.definition.name, input: { account: 'before-discovery' } }],
      toolContext: { version: 1, directCalls: [{ id: 'eager-call', name: alpha.definition.name }] } };
    const result: Message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'eager-call', content: 'Earlier direct result.' }] };
    const source = [baseline(snapshot([], 'eager')), eager, result, ...discovery(alpha)];
    const current = snapshot([alpha]);
    const prepared = prepareToolContextCheckpoint([baseline(current), ...source], source, current);
    expect(readToolContextSnapshot(prepared)?.definitions).toEqual([alpha]);
    expect(prepared).toContainEqual(eager);
    expect(prepared).toContainEqual(result);
    expect(prepareToolContextCheckpoint(prepared, prepared, current)).toEqual(prepared);
  });

  it.each(['untrusted', 'truncated', 'wrong-schema', 'error'] as const)('does not omit recovery based on a %s result', kind => {
    const current = snapshot([alpha]);
    const retained = discovery(alpha);
    const result = retained[1];
    if (kind === 'untrusted') delete result.toolContext;
    const block = (result.content as Array<{ content: string; is_error?: boolean }>)[0];
    if (kind === 'truncated') block.content = block.content.slice(0, -12);
    if (kind === 'wrong-schema') {
      const payload = JSON.parse(block.content);
      payload.tools[0].input_schema = { type: 'object' };
      block.content = JSON.stringify(payload);
    }
    if (kind === 'error') { block.is_error = true; delete result.toolContext; }
    const prepared = prepareToolContextCheckpoint([baseline(current), ...retained], retained, current);
    expect(prepared[0].content).toContain(alpha.definition.description);
    expect(prepared.slice(1)).toEqual(retained);
    expect(readToolContextSnapshot(prepared)?.definitions).toEqual([alpha]);
  });

  it('does not regrant a retired definition from a retained discovery delta', () => {
    const source = [baseline(snapshot([alpha], 'retired')), ...discovery(alpha), ...call(alpha)];
    const current = snapshot([], 'replacement');
    const prepared = prepareToolContextCheckpoint([baseline(current), ...source], source, current);
    expect(prepared.filter(message => message.toolContext?.baseline)).toHaveLength(1);
    expect(readToolContextSnapshot(prepared)?.definitions).toEqual([]);
    expect(prepared[0].toolContext?.baseline?.historicalDefinitions).toEqual([alpha]);
    expect(prepared.some(message => message.toolContext?.discoveries?.length)).toBe(false);
    expect(prepared.at(-2)?.content).toEqual(source.at(-2)?.content);
    expect(prepared.at(-1)?.content).toEqual(source.at(-1)?.content);
    expect(visible(prepared)).toContain('Receipt 42.');
    expect(prepareToolContextCheckpoint(prepared, prepared, current)).toEqual(prepared);
  });

  it('keeps a real user body when stripping its redundant empty baseline', () => {
    const empty: ToolContextSnapshot = { version: 1, generation: 'empty', discoveryEntries: false, directory: '', definitions: [] };
    const user: Message = { role: 'user', content: 'Do not delete files. Report the results.', toolContext: { version: 1, baseline: empty } };
    const prepared = prepareToolContextCheckpoint([baseline(empty), user], [user], empty);
    expect(prepared).toContainEqual({ role: 'user', content: user.content });
    expect(prepared.filter(message => message.toolContext?.baseline)).toHaveLength(1);
    expect(readToolContextSnapshot(prepared)?.definitions).toEqual([]);
    expect(user.toolContext?.baseline).toEqual(empty);
  });

  it.each([false, true])('attaches an empty baseline to the existing summary without losing it later (entries=%s)', discoveryEntries => {
    const empty: ToolContextSnapshot = { version: 1, generation: 'empty', discoveryEntries, directory: '', definitions: [] };
    const summary: Message = { role: 'user', content: 'Keep the verified work constraints.' };
    const source = [baseline(empty), { role: 'user' as const, content: 'Continue the task.' }];
    const prepared = prepareToolContextCheckpoint([summary, baseline(empty), ...source], source, empty);
    expect(prepared[0].content).toBe(summary.content);
    expect(prepared[0].toolContext).toMatchObject({ baseline: empty, baselineAttachment: false });
    expect(prepared.some(message => message.content === '')).toBe(false);
    expect(readToolContextSnapshot(prepared)?.definitions).toEqual([]);
    const again = prepareToolContextCheckpoint([
      { role: 'user', content: 'Another summary.' }, baseline(empty), ...prepared,
    ], prepared, empty);
    expect(again.some(message => message.content === summary.content)).toBe(true);
    expect(again[0].content).toBe('Another summary.');
    expect(again.filter(message => message.toolContext?.baseline)).toHaveLength(1);
    expect(again.some(message => message.content === '')).toBe(false);
  });

  it('reconciles two real compactions even when summaries never name tools', async () => {
    const current = snapshot([alpha, beta]);
    const source = [...longWork(14), baseline(snapshot([alpha], 'previous')), ...discovery(beta), ...call(alpha)];
    const original = structuredClone(source);
    const first = await fullCompact(source, summaryProvider(), 'fixture', '', [baseline(current)], undefined, undefined, {
      prepareCandidate: candidate => prepareToolContextCheckpoint(candidate, source, current),
    });
    expect(first.summary).not.toContain('mcp__');
    expect(first.messages.filter(message => message.toolContext?.baseline)).toHaveLength(1);
    expect(readToolContextSnapshot(first.messages)?.definitions).toEqual([alpha, beta]);
    expect(visible(first.messages).split(beta.definition.description)).toHaveLength(2);
    expect(first.tokensFreed).toBe(estimateMessageTokens(source) - estimateMessageTokens(first.messages));
    expect(source).toEqual(original);

    const nextSource = [...first.messages, ...longWork(14)];
    const second = await fullCompact(nextSource, summaryProvider(), 'fixture', '', [baseline(current)], undefined, undefined, {
      prepareCandidate: candidate => prepareToolContextCheckpoint(candidate, nextSource, current),
    });
    expect(second.messages.filter(message => message.toolContext?.baseline)).toHaveLength(1);
    expect(readToolContextSnapshot(second.messages)?.definitions).toEqual([alpha, beta]);
    expect(visible(second.messages).split(alpha.definition.description)).toHaveLength(2);
    expect(visible(second.messages).split(beta.definition.description)).toHaveLength(2);
    expect(visible(second.messages).split(guide)).toHaveLength(2);
    expect(second.tokensFreed).toBe(estimateMessageTokens(nextSource) - estimateMessageTokens(second.messages));
  });
});
