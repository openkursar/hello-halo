import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const { parseSSEStream, applyModelQuirks, applyStreamQuirks } = await import(pathToFileURL(join(compiled, 'native/provider-helpers.js')).href);
const { resolveQueryConfig } = await import(pathToFileURL(join(compiled, 'native/config.js')).href);

test('native SSE parser keeps chunk boundaries, event metadata and early return ownership', async () => {
  const source = new TextEncoder().encode('\ufeff:comment\r\nevent: fixture\r\ndata: {broken}\r\ndata: {"text":"😀"}\n\nevent: array\ndata: [1,2]\ndata: 42\ndata: [DONE]\ndata: {"ignored":true}\n');
  let index = 0, cancelled = 0;
  const stream = new ReadableStream({ pull(controller) { if (index < source.length) controller.enqueue(source.slice(index, ++index)); else controller.close(); }, cancel() { cancelled++; } });
  const output = [];
  for await (const record of parseSSEStream(new Response(stream))) output.push(record);
  assert.deepEqual(output[0], { text: '😀', __event: 'fixture' });
  assert.deepEqual([...output[1]], [1, 2]); assert.equal(output[1].__event, 'array');
  assert.equal(output[2], 42); assert.equal(output.length, 3); assert.equal(cancelled, 1);
  let early = 0;
  const iterator = parseSSEStream(new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"first":true}\ndata: {"later":true}\n')); }, cancel() { early++; } })));
  assert.deepEqual((await iterator.next()).value, { first: true });
  await iterator.return(); assert.equal(early, 1);
});

test('SSE abort does not await an uncooperative source cancel promise', { timeout: 3000 }, async () => {
  const controller = new AbortController(); let cancelled = 0;
  const iterator = parseSSEStream(new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } })), controller.signal);
  const pending = iterator.next(), reason = new Error('fixture cancellation');
  controller.abort(reason); await assert.rejects(pending, error => error === reason); assert.equal(cancelled, 1);
  await assert.rejects(async () => { for await (const _event of parseSSEStream(new Response(null))) {} }, /Response body is not readable/);
});

test('model response repair preserves unchanged blocks and response-owned references', () => {
  const input = { value: 'kept' }, usage = { input_tokens: 2, output_tokens: 1 };
  const block = { type: 'tool_use', id: 'call', name: 'Check', input };
  const response = { id: 'fixture', model: 'fixture', content: [block], stopReason: 'end_turn', usage };
  const repaired = applyModelQuirks('fixture', response);
  assert.notEqual(repaired, response); assert.notEqual(repaired.content, response.content);
  assert.equal(repaired.content[1], block); assert.equal(repaired.usage, usage); assert.equal(repaired.stopReason, 'tool_use');
  const missing = { ...block, id: '' };
  const generated = applyModelQuirks('fixture', { ...response, content: [missing] });
  assert.notEqual(generated.content[1], missing); assert.equal(generated.content[1].input, input);
  assert.match(generated.content[1].id, /^toolu_/);
  const empty = { ...block, input: {} };
  const copied = applyModelQuirks('deepseek', { ...response, content: [empty] });
  assert.notEqual(copied.content[1], empty); assert.notEqual(copied.content[1].input, empty.input); assert.deepEqual(copied.content[1].input, {});
  const event = { type: 'message_stop' }; assert.equal(applyStreamQuirks('fixture', event), event);
});

test('native configuration preserves caller capabilities while snapshotting policy data', () => {
  const controller = new AbortController(), env = { HOME: '/fixture/home' }, thinking = { type: 'disabled' };
  const hooks = { Stop: [{ hooks: [async () => ({})] }] }, permissions = async () => ({ behavior: 'allow' });
  const skills = [{ name: 'commit.md', description: 'Fixture', source: { kind: 'builtin', name: 'commit' } }];
  const options = { model: 'fixture', cwd: '/fixture/project', env, thinking, hooks, canUseTool: permissions, abortController: controller,
    skillCatalog: skills, toolDiscovery: { services: { fixture: { identity: 'fixture', loading: 'deferred', summary: undefined } } } };
  const config = resolveQueryConfig(options);
  assert.equal(config.env, env); assert.equal(config.thinking, thinking); assert.equal(config.hooks, hooks);
  assert.equal(config.canUseTool, permissions); assert.equal(config.abortSignal, controller.signal);
  assert.notEqual(config.skillCatalog, skills); assert.equal(config.skillCatalog[0].name, 'commit');
  assert.ok(Object.isFrozen(config.skillCatalog)); assert.ok(Object.isFrozen(config.skillCatalog[0].source));
  assert.notEqual(config.toolDiscovery, options.toolDiscovery); assert.ok(Object.hasOwn(config.toolDiscovery.services.fixture, 'summary'));
  assert.equal(config.maxBudgetUsd, Infinity);
  assert.throws(() => resolveQueryConfig({ model: 'fixture', toolDiscovery: null }), TypeError);
});
