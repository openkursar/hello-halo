import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const { ToolDiscoveryState } = await import(pathToFileURL(join(compiled, process.env.SDK_DISCOVERY_ENTRY ?? 'native/tool-discovery.js')).href);
const definition = { name: 'mcp__fixture__read', description: 'Read a fixture.', inputSchema: { type: 'object' },
  mcpSource: { server: 'fixture', name: 'read' }, permissionLevel: 'readonly', async execute() { return { content: 'read' }; } };
const state = () => new ToolDiscoveryState([definition], { services: { fixture: { identity: 'fixture', loading: 'deferred' } } }, 32768, 10000);

test('discovery keeps ordinary result and metadata references when there is no owned search', () => {
  const owner = state();
  const content = [{ type: 'text', text: 'external result' }];
  const block = { type: 'tool_result', tool_use_id: 'external', content };
  const metadata = { version: 1, directCalls: [{ id: 'external', name: 'external' }] };
  const message = { role: 'user', content: [block], toolContext: metadata };
  const blocks = message.content;
  owner.finalizeResults(message);
  assert.equal(message.content, blocks);
  assert.equal(message.content[0], block);
  assert.equal(block.content, content);
  assert.equal(message.toolContext, metadata);
  const direct = { type: 'tool_use', id: 'direct', name: 'Other', input: {} };
  assert.equal(owner.normalize(direct).call, direct);
});

test('search finalization changes only its own blocks and retains unrelated metadata members', async () => {
  const owner = state();
  const found = await owner.searchTool.execute({ query: 'select:mcp__fixture__read' }, { toolUseId: 'search' });
  const settled = owner.settle('search', found);
  assert.equal(settled.result, found);
  const externalContent = [{ type: 'text', text: 'external result' }];
  const external = { type: 'tool_result', tool_use_id: 'external', content: externalContent };
  const discovered = { type: 'tool_result', tool_use_id: 'search', content: found.content };
  const directCalls = [{ id: 'external', name: 'Other' }];
  const metadata = { ...settled.record, directCalls };
  const message = { role: 'user', content: [external, discovered], toolContext: metadata };
  owner.finalizeResults(message);
  assert.equal(message.content[0], external);
  assert.equal(external.content, externalContent);
  assert.equal(message.content[1], discovered);
  assert.notEqual(message.toolContext, metadata);
  assert.equal(message.toolContext.directCalls, directCalls);
  owner.commit(message.toolContext);
  const entry = owner.catalog.deferred.get(definition.name);
  assert.equal(owner.catalog.search('select:mcp__fixture__read')[0], entry);
});

test('rejected search feedback is a fresh error without copying untrusted result fields', async () => {
  const owner = state();
  await owner.searchTool.execute({ query: 'read' }, { toolUseId: 'search' });
  const result = { content: 'changed by hook', isError: false, metadata: { untrusted: true }, images: [{ data: 'untrusted' }] };
  const settled = owner.settle('search', result);
  assert.notEqual(settled.result, result);
  assert.deepEqual(Object.keys(settled.result), ['content', 'isError']);
  assert.equal(settled.result.isError, true);
  assert.equal(settled.record, undefined);
});
