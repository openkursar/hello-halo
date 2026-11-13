import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const hooks = await import(pathToFileURL(join(compiled, 'native/hooks.js')).href);
const compact = await import(pathToFileURL(join(compiled, 'native/compact.js')).href);
const values = await import(pathToFileURL(join(compiled, 'native/values.js')).href);
const signal = () => new AbortController().signal;

test('native scalar text helpers preserve recorded UTF-16 values and numeric budget errors', async () => {
  const fixtures = JSON.parse(await readFile(new URL('../native/crates/halo-core/src/core/fixtures/text-helpers.json', import.meta.url), 'utf8'));
  const text = units => String.fromCharCode(...units);
  const texts = fixtures.texts.map(text);
  for (const [index, input] of texts.entries()) assert.equal(values.estimateTokens(input), fixtures.estimates[index], `estimate ${index}`);
  for (const [index, fixture] of fixtures.truncations.entries()) {
    const operation = () => values.truncateToolResult(texts[fixture.text], Number(fixture.budget));
    if (fixture.error) assert.throws(operation, error => error.name === fixture.error.name && error.message === fixture.error.message, `truncate ${index}`);
    else assert.equal(operation(), text(fixture.units), `truncate ${index}`);
  }
  for (const [index, fixture] of fixtures.splits.entries()) {
    assert.deepEqual(values.splitAtBoundary(text(fixture.input)), fixture.output.map(text), `split ${index}`);
  }
  assert.equal(values.truncateToolResult('\ud800'.repeat(50_000)), '\ud800'.repeat(50_000));
  assert.equal(createHash('sha256').update(Buffer.from(values.truncateToolResult('\ud800'.repeat(50_001)), 'utf16le')).digest('hex'), fixtures.defaultTruncation);
});

test('native text helpers preserve falsy estimation and validate budgets before inspecting content', () => {
  for (const input of [undefined, null, false, 0, -0, NaN, 0n, '']) assert.equal(values.estimateTokens(input), 0);
  let reads = 0;
  const original = { get length() { reads++; throw new Error('Content must remain untouched'); } };
  for (const input of [undefined, null, false, 0, NaN, 0n, Symbol('text'), original, () => {}]) {
    assert.equal(values.truncateToolResult(input, Infinity), input);
  }
  for (const budget of [null, false, true, '1', {}, [], new Number(1), Symbol('budget'), 1n]) {
    assert.throws(() => values.truncateToolResult(original, budget), error =>
      error.name === 'RangeError' && error.message === 'Text output budget must be a nonnegative integer');
  }
  assert.equal(reads, 0);
});

test('native public hook helpers preserve input threading and output object references', async () => {
  const original = { before: true }, updated = { changed: true }, replacement = { payload: 'value' };
  let input;
  const result = await hooks.runPreToolUseHooks({ PreToolUse: [{ matcher: 'Re*', hooks: [
    async value => { input = value; assert.equal(value.tool_input, original); original.mutated = true;
      return { permissionDecision: 'deny', updatedInput: updated, additionalContext: 'first' }; },
    async value => { assert.equal(value, input); assert.equal(value.tool_input, updated); updated.after = true;
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', additionalContext: 'second' } }; },
  ] }] }, 'Read', original, 'tool', 'session', process.cwd(), signal());
  assert.deepEqual(result, { decision: 'allow', updatedInput: updated, additionalContext: 'first\nsecond' });
  assert.equal(result.updatedInput, updated);
  assert.equal(original.mutated, true);
  const response = { body: 'result' };
  const post = await hooks.runPostToolUseHooks({ PostToolUse: [{ hooks: [async value => {
    assert.equal(value.tool_input, original); assert.equal(value.tool_response, response);
    return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedMCPToolOutput: replacement } };
  }] }] }, 'Read', original, response, 'tool', 'session', process.cwd(), signal());
  assert.equal(post.updatedToolOutput, replacement);
});

test('native hook observers mutate the original payload and timed-out hooks cannot misalign later outputs', async () => {
  const input = { session_id: 'session', count: 0 }, first = { first: true }, second = { second: true };
  const seen = [];
  const output = await hooks.runHooks('Stop', [{ hooks: [async value => { assert.equal(value, input); return first; },
    async value => { assert.equal(value, input); assert.equal(value.count, 1); return second; }] }], input, undefined, signal(), undefined,
  value => { seen.push(value); input.count++; value.observed = true; });
  assert.equal(output[0], first); assert.equal(output[1], second); assert.deepEqual(seen, [first, second]);
  assert.equal(input.count, 2);
  const late = { late: true }, timely = { timely: true };
  const timed = await hooks.runHooks('Stop', [{ timeout: 0.001, hooks: [async () => { await delay(30); return late; }] },
    { hooks: [async () => timely] }], { session_id: 'session' }, undefined, signal());
  assert.deepEqual(timed[0], { hookError: 'Hook "Stop" timed out after 1ms' }); assert.equal(timed[1], timely);
  await delay(35);
});

test('native public hooks retain advisory cancellation while compaction propagates abort', async () => {
  const controller = new AbortController();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const work = hooks.runHooks('Stop', [{ hooks: [async (_input, _id, { signal }) => {
    started(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  }] }], { session_id: 'session' }, undefined, controller.signal);
  await ready; controller.abort();
  assert.deepEqual(await work, [{ hookError: 'Hook "Stop" aborted' }]);
  const aborted = new AbortController(); aborted.abort(new Error('fixture interruption'));
  await assert.rejects(compact.fullCompact([], {}, 'fixture', '', [], undefined, undefined, { signal: aborted.signal }), /fixture interruption/);
});

test('native public compaction preserves no-op references and reconciles append-only history through callbacks', async () => {
  const message = { role: 'user', content: 'one' }, small = [message];
  const unused = { capabilities() { throw new Error('No provider work is needed'); } };
  const nothing = await compact.fullCompact(small, unused, 'fixture', '');
  assert.notEqual(nothing.messages, small); assert.equal(nothing.messages[0], message);
  const history = Array.from({ length: 16 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `record-${index} ${'long evidence '.repeat(100)}` }));
  const appended = { role: 'user', content: 'New correction while summary is being prepared.' };
  const requests = [], responses = [];
  const provider = { async createMessage(request) {
    requests.push(request); history.push(appended);
    return { id: 'summary', model: 'fixture', stopReason: 'end_turn', content: [{ type: 'text', text: '<summary>Preserved evidence and unfinished task.</summary>' }], usage: { input_tokens: 20, output_tokens: 5 } };
  } };
  const result = await compact.fullCompact(history, provider, 'fixture', 'unused', [], undefined, '/fixture/transcript.jsonl', { onResponse: response => responses.push(response) });
  assert.equal(requests.length, 1); assert.equal(responses.length, 1); assert.equal(responses[0].id, 'summary');
  assert.equal(result.messages.at(-1).content, appended.content); assert.ok(result.tokensFreed > 0);
  assert.match(result.summary, /Preserved evidence and unfinished task/);
  assert.match(result.messages[0].content, /\/fixture\/transcript\.jsonl/);
  const changed = Array.from({ length: 16 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'original '.repeat(50) }));
  await assert.rejects(compact.fullCompact(changed, { async createMessage() {
    changed[0].content = 'changed concurrently';
    return { id: 'summary', model: 'fixture', stopReason: 'end_turn', content: [{ type: 'text', text: 'Summary' }] };
  } }, 'fixture', ''), error => error.name === 'CompactionError' && error.reason === 'history_changed');
});

test('native synchronous helpers keep accounting and request-budget state in the binding', () => {
  const reported = [];
  const tracker = new values.CostTracker('fixture', 1000, { fixture: { inputPerMtk: 2, outputPerMtk: 4, cacheCreationPerMtk: 3, cacheReadPerMtk: 1 } }, (entry, model) => reported.push({ entry, model }));
  tracker.add({ input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 }, 'fixture');
  tracker.add({ input_tokens: NaN, output_tokens: -1, cache_creation_input_tokens: Infinity });
  assert.equal(tracker.totalTokens, 180); assert.equal(tracker.totalCostUsd, 0.00045);
  assert.equal(reported.length, 2); assert.equal(reported[1].model, 'unknown');
  const budget = new values.TokenBudget(10000, 1000);
  assert.equal(budget.contextWindow, 10000); assert.equal(budget.maxOutputTokens, 1000);
  budget.configureOutput({ type: 'enabled', budgetTokens: 2000 }, 4000);
  assert.equal(budget.outputReservationTokens, 1000);
  assert.equal(values.estimateTokens(''), 0); assert.ok(values.estimateTokens('hello world') > 0);
  assert.throws(() => values.truncateToolResult('text', -1), RangeError);
  assert.equal(values.truncateToolResult('text', Infinity), 'text');
  const catalog = values.getHarnessTextCatalog();
  assert.ok(catalog.some(entry => entry.id === 'providers.xml.instructions'));
  tracker.reset(); assert.equal(tracker.totalTokens, 0); assert.deepEqual(tracker.getModelUsage(), {});
  const precise = new values.CostTracker('fixture', 1794339331661.0015); precise.add(undefined, 'fixture');
  const copied = new values.CostTracker('fixture'); copied.addReportedUsage(precise.getModelUsage());
  assert.equal(copied.getModelUsage().fixture.contextWindow, 1794339331661.0015);
});

test('native local compaction preserves unchanged references and automatic failure state', async () => {
  const messages = Array.from({ length: 4 }, (_, index) => [
    { role: 'assistant', content: [{ type: 'tool_use', id: String(index), name: 'Read', input: { path: `file-${index}` } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: String(index), content: 'recorded evidence '.repeat(200) }] },
  ]).flat();
  assert.equal(compact.microCompact(messages, Infinity).messages, messages);
  const reduced = compact.microCompact(messages, 500);
  assert.notEqual(reduced.messages, messages); assert.ok(reduced.truncatedCount > 0);
  assert.equal(reduced.messages.at(-1), messages.at(-1));
  assert.notEqual(reduced.messages[1], messages[1]);
  const anchor = { estimateWithAnchor(value) { assert.equal(value, messages); return 1; } };
  assert.equal(compact.apiCompact(messages, anchor, 1000), null);
  assert.equal(compact.formatCompactSummary('<analysis>thought</analysis>\n<summary>saved</summary>'), 'Summary:\nsaved');
  assert.match(compact.getCompactPrompt('Preserve fixture'), /Preserve fixture/);
  const state = new compact.AutoCompactState();
  const history = Array.from({ length: 16 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'earlier record '.repeat(50) }));
  const provider = { async createMessage() { throw new Error('fixture provider unavailable'); } };
  for (let index = 0; index < 3; index++) assert.equal(await compact.autoCompactIfNeeded(history, 999, 1000, 'fixture', provider, '', state), null);
  assert.equal(state.consecutiveFailures, 3); assert.equal(state.disabled, true);
  state.onSuccess(); assert.equal(state.compactionCount, 1); assert.equal(state.consecutiveFailures, 0); assert.equal(state.disabled, true);
});
