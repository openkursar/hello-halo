import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? new URL('../dist/', import.meta.url).pathname;
const { queryLoop, createSession } = await import(pathToFileURL(join(compiled, process.env.SDK_LOOP_ENTRY ?? 'native/index.js')).href);
const { ProviderError, ModelFallbackError } = await import(pathToFileURL(join(compiled, 'utils/errors.js')).href);
const capabilities = { streaming: true, toolCalling: true, thinking: true, imageInput: true,
  pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' };
const deadline = { timeout: 30_000 };

function config(cwd, overrides = {}) {
  return { model: 'fixture', maxTokens: 1024, contextWindow: 200_000, maxTurns: 6, maxBudgetUsd: Infinity,
    cwd, env: { HOME: cwd, CLAUDE_CONFIG_DIR: join(cwd, 'state') }, systemPrompt: 'Fixture instructions.',
    thinking: { type: 'disabled' }, thinkingExplicit: true, effort: 'high', toolResultBudget: 50_000,
    includePartialMessages: true, permissionMode: 'bypassPermissions', toolCallingMode: 'native',
    turnEndChecks: { openWork: true, completion: false }, settingSources: [],
    abortSignal: new AbortController().signal, ...overrides };
}
function frames(request, content, stopReason = 'end_turn') {
  const usage = { input_tokens: 10, output_tokens: 3 };
  return [{ type: 'message_start', id: 'response', model: request.model, usage },
    ...content.flatMap((content_block, index) => [{ type: 'content_block_start', index, content_block },
      { type: 'content_block_stop', index }]),
    { type: 'message_delta', stopReason, usage }, { type: 'message_stop' }];
}
function provider(script, requests = []) {
  return { id: 'fixture', name: 'Fixture', capabilities: () => capabilities,
    async createMessage() { throw new Error('Unexpected summary request'); },
    async *createMessageStream(request) { requests.push(request); for (const event of await script(request, requests.length)) yield event; } };
}
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'halo-native-loop-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
async function drain(iterator) { const events = []; for await (const event of iterator) events.push(event); return events; }
const call = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const text = value => ({ type: 'text', text: value });

test('tool discovery callbacks retain operational state and replace it only for a changed catalog', deadline, async t => {
  const cwd = await temporary(t);
  const eager = { name: 'EagerFixture', description: 'Eager fixture', inputSchema: { type: 'object' }, permissionLevel: 'readonly',
    async execute() { return { content: 'eager' }; } };
  let effects = 0;
  const tool = description => ({ name: 'mcp__fixture__lookup', description, inputSchema: { type: 'object' },
    mcpSource: { server: 'fixture', name: 'lookup', toolDescription: description }, permissionLevel: 'readonly',
    async execute() { effects++; return { content: 'LOOKUP_EFFECT' }; } });
  const initial = tool('Initial lookup'), updated = tool('Updated lookup'), latest = tool('Latest lookup');
  let refresh = 0;
  const states = [];
  const model = provider((request, index) => {
    if (index === 1) return frames(request, [call('discover', 'ToolSearch', { query: 'select:mcp__fixture__lookup' })], 'tool_use');
    if (index === 2) return frames(request, [call('execute', 'CallTool', { tool: updated.name, arguments: '{}' })], 'tool_use');
    assert.match(JSON.stringify(request.messages), /LOOKUP_EFFECT/);
    return frames(request, [text('Lookup complete.')]);
  });
  const events = await drain(queryLoop(config(cwd, { turnEndChecks: { openWork: false, completion: false },
    toolDiscovery: { services: { fixture: { identity: 'fixture-installation', loading: 'deferred' } } } }),
  model, [eager, initial], 'lookup', {
    getToolState() { return [eager, ++refresh < 3 ? updated : latest]; },
    onToolContextChange(state) {
      assert.equal(state.catalog.eager[0], eager);
      assert.equal(state.needsBaseline, false);
      assert.equal(typeof state.searchTool.execute, 'function');
      states.push(state);
    },
  }));
  assert.equal(events.at(-1).result, 'Lookup complete.');
  assert.equal(effects, 1);
  assert.equal(states.length, 3);
  assert.equal(states[0], states[1]);
  assert.notEqual(states[1], states[2]);
  assert.equal(states[0].snapshot().definitions.length, 1);
  assert.equal(states[0].snapshot().definitions[0].definition.description, updated.description);
  assert.equal(states[2].snapshot().definitions.length, 0);
});

// A public generator must remain parked at each yielded frame until its caller advances.
test('initial pull and early return do not start a provider or a tool', deadline, async t => {
  const cwd = await temporary(t); const requests = []; const progress = [];
  const iterator = queryLoop(config(cwd), provider(request => frames(request, [text('unexpected')]), requests), [], 'start',
    { onProgress: event => progress.push(event.type) });
  assert.equal(requests.length, 0);
  assert.equal((await iterator.next()).value.subtype, 'init');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(requests.length, 0); assert.deepEqual(progress, []);
  await iterator.return(); assert.equal(requests.length, 0); assert.deepEqual(progress, []);
});

test('owner checkpoints precede real effects and result persistence precedes the next request', deadline, async t => {
  const cwd = await temporary(t); const effect = join(cwd, 'effect'); const checkpoint = join(cwd, 'checkpoint');
  const record = join(cwd, 'result'); const order = []; const requests = [];
  const tool = { name: 'WriteFixture', description: 'Write a fixture.', inputSchema: { type: 'object', required: ['content'], properties: { content: { type: 'string' } } },
    permissionLevel: 'write', async execute(input) { await access(checkpoint); order.push('effect'); await writeFile(effect, input.content); return { content: 'Written.' }; } };
  const model = provider(async (request, index) => {
    if (index === 1) return frames(request, [call('write', tool.name, { content: 'recorded effect' })], 'tool_use');
    assert.equal(await readFile(record, 'utf8'), 'Written.');
    assert.ok(JSON.stringify(request.messages).includes('Written.')); return frames(request, [text('Finished.')]);
  }, requests);
  const events = await drain(queryLoop(config(cwd), model, [tool], 'write', {
    async onAssistantBlock(frame, response) { assert.equal(typeof response, 'string'); if (frame.message.content[0].type === 'tool_use') { order.push('checkpoint'); await writeFile(checkpoint, frame.uuid); } },
    onAssistantMessage(frame) { order.push(`response:${frame.message.stop_reason}`); },
    async onToolResultMessage(frame) { order.push('result'); await writeFile(record, frame.message.content[0].content); },
  }));
  assert.equal(await readFile(effect, 'utf8'), 'recorded effect'); assert.equal(requests.length, 2);
  assert.ok(order.indexOf('checkpoint') < order.indexOf('effect'));
  assert.ok(order.indexOf('response:tool_use') < order.indexOf('result'));
  assert.equal(events.at(-1).result, 'Finished.'); assert.equal(events.at(-1).num_turns, 2);
});

test('a rejected owner checkpoint cannot execute the corresponding tool', deadline, async t => {
  const cwd = await temporary(t); let executed = 0;
  const tool = { name: 'Effect', description: 'Fixture.', inputSchema: { type: 'object' }, permissionLevel: 'write',
    async execute() { executed++; return { content: 'unexpected' }; } };
  const events = await drain(queryLoop(config(cwd), provider(request => frames(request, [call('blocked', tool.name)], 'tool_use')), [tool], 'start', {
    onAssistantBlock() { throw new Error('Fixture checkpoint unavailable'); },
  }));
  assert.equal(executed, 0); assert.equal(events.at(-1).is_error, true);
  assert.match(events.at(-1).result, /Fixture checkpoint unavailable/);
});

test('fallback uses one new model without multiplying provider-exhausted retries', deadline, async t => {
  const cwd = await temporary(t); const requests = [];
  const events = await drain(queryLoop(config(cwd, { fallbackModel: 'backup' }), provider((request, index) => {
    if (index === 1) throw new ModelFallbackError('Fixture overload budget spent');
    return frames(request, [text('Backup answer.')]);
  }, requests), [], 'start'));
  assert.deepEqual(requests.map(request => request.model), ['fixture', 'backup']);
  assert.deepEqual(requests.map(request => request.providerOptions.fallbackModelAvailable), [true, false]);
  const fallback = events.find(event => event.subtype === 'model_fallback');
  assert.equal(fallback.from_model, 'fixture'); assert.equal(fallback.to_model, 'backup');
  assert.equal(events.some(event => event.subtype === 'api_retry'), false); assert.equal(events.at(-1).num_turns, 1);
});

test('a failed usage receipt closes the interrupted provider and accounts usage only once', deadline, async t => {
  const cwd = await temporary(t);
  let requests = 0, closed = 0, callbacks = 0;
  const model = {
    id: 'fixture', name: 'Fixture', capabilities: () => capabilities,
    async createMessage() { throw new Error('Unexpected summary request'); },
    async *createMessageStream(request) {
      requests++;
      try {
        yield { type: 'message_start', id: 'interrupted', model: request.model, usage: { input_tokens: 11, output_tokens: 2 } };
        yield { type: 'retry', attempt: 1, maxRetries: 10, delayMs: 0, status: 503, message: 'Fixture interruption' };
        assert.fail('A failed receipt must stop the provider before another request');
      } finally { closed++; }
    },
  };
  const events = await drain(queryLoop(config(cwd), model, [], 'Start.', {
    onUsage() { callbacks++; throw new Error('Fixture receipt callback failed'); },
  }));
  assert.equal(requests, 1);
  assert.equal(closed, 1);
  assert.equal(callbacks, 1);
  const results = events.filter(event => event.type === 'result');
  assert.equal(results.length, 1);
  assert.equal(results[0].is_error, true);
  assert.match(results[0].result, /Fixture receipt callback failed/);
  assert.equal(results[0].usage.input_tokens, 11);
  assert.equal(results[0].usage.output_tokens, 2);
});

test('raw provider output rejection is corrected only before content starts', deadline, async t => {
  const cwd = await temporary(t); const requests = [];
  const events = await drain(queryLoop(config(cwd), provider((request, index) => {
    if (index === 1) throw Object.assign(new Error('max_tokens must be between 1 and 512'), { status: 400 });
    return frames(request, [text('Corrected.')]);
  }, requests), [], 'start'));
  assert.deepEqual(requests.map(request => request.maxTokens), [1024, 512]);
  assert.equal(events.at(-1).result, 'Corrected.'); assert.equal(events.at(-1).num_turns, 1);
});

test('reasoning recovery removes old signatures and keeps this run’s signed response', deadline, async t => {
  const cwd = await temporary(t); const requests = []; const rewrites = [];
  const tool = { name: 'Check', description: 'Fixture.', inputSchema: { type: 'object' }, permissionLevel: 'readonly', async execute() { return { content: 'Checked.' }; } };
  const history = [{ role: 'user', content: 'Prior task.' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'old', signature: 'old-signature' }, text('Old answer.')] }, { role: 'user', content: 'Continue.' }];
  const events = await drain(queryLoop(config(cwd), provider((request, index) => {
    if (index === 1) return frames(request, [{ type: 'thinking', thinking: 'new', signature: 'own-signature' }, call('check', tool.name)], 'tool_use');
    if (index === 2) throw new ProviderError('Invalid signature in thinking block', { statusCode: 400 });
    return frames(request, [text('Recovered.')]);
  }, requests), [tool], history, { onHistoryCompacted: messages => rewrites.push(structuredClone(messages)) }));
  assert.equal(requests.length, 3); assert.equal(rewrites.length, 1);
  assert.ok(JSON.stringify(requests[1].messages).includes('old-signature'));
  assert.ok(!JSON.stringify(requests[2].messages).includes('old-signature'));
  assert.ok(JSON.stringify(requests[2].messages).includes('own-signature'));
  assert.equal(events.at(-1).num_turns, 2);
});

test('image relabeling reaches the owner before the provider sees the corrected request', deadline, async t => {
  const cwd = await temporary(t); const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(32).fill(0)]).toString('base64');
  let rewritten;
  const events = await drain(queryLoop(config(cwd), provider(request => {
    assert.equal(rewritten[0].content[0].source.media_type, 'image/png');
    const image = request.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).find(block => block.type === 'image');
    assert.equal(image.source.media_type, 'image/png');
    return frames(request, [text('Seen.')]);
  }), [], [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: png } }] }],
  { onHistoryCompacted: history => { rewritten = history; } }));
  assert.equal(events.at(-1).result, 'Seen.');
});

test('a slow consumer can return at tool progress before the tool effect starts', deadline, async t => {
  const cwd = await temporary(t); let effects = 0; const observed = [];
  const tool = { name: 'HeldEffect', description: 'Fixture.', inputSchema: { type: 'object' }, permissionLevel: 'write',
    async execute() { effects++; return { content: 'ran' }; } };
  const iterator = queryLoop(config(cwd), provider(request => frames(request, [call('held', tool.name)], 'tool_use')), [tool], 'start',
    { onProgress: event => observed.push(event.type) });
  for (;;) { const next = await iterator.next(); assert.equal(next.done, false); if (next.value.type === 'tool_progress') break; }
  assert.ok(observed.includes('tool_progress')); assert.equal(effects, 0);
  await iterator.return(); assert.equal(effects, 0);
});

test('custom tools retain the supplied map and one cost object, including synchronous usage observers', deadline, async t => {
  const cwd = await temporary(t); const readState = new Map(); const original = { timestamp: 1, content: 'before' };
  readState.set('/fixture', original); const observations = []; let tracker;
  const tool = { name: 'ObserveState', description: 'Fixture.', inputSchema: { type: 'object' }, permissionLevel: 'readonly',
    async execute(_input, context) {
      assert.equal(context.readFileState, readState); assert.equal(context.readFileState.get('/fixture'), original);
      const current = context.costTracker;
      if (!tracker) {
        tracker = current; const before = observations.length;
        current.add({ input_tokens: 7, output_tokens: 2 }, 'fixture');
        assert.equal(observations.length, before + 1, 'Tool-owned usage is observed synchronously');
        original.content = 'changed';
      } else { assert.equal(current, tracker); assert.equal(readState.get('/fixture').content, 'changed'); }
      return { content: 'Observed.' };
    } };
  const events = await drain(queryLoop(config(cwd), provider((request, index) => frames(request,
    index <= 2 ? [call(`observe-${index}`, tool.name)] : [text('Done.')], index <= 2 ? 'tool_use' : 'end_turn')),
  [tool], 'start', { readFileState: readState, onUsage: (usage, model) => observations.push({ usage, model }) }));
  assert.equal(events.at(-1).usage.input_tokens, 37); assert.equal(events.at(-1).usage.output_tokens, 11);
  assert.equal(tracker.totalInputTokens, 37); assert.equal(observations.length, 4);
});

test('cancellation during an output hook preserves the completed write in the owner record', deadline, async t => {
  const cwd = await temporary(t); const file = join(cwd, 'completed-write'); const controller = new AbortController();
  const recorded = []; let hookEntered;
  const entered = new Promise(resolve => { hookEntered = resolve; });
  const tool = { name: 'WriteOnce', description: 'Fixture.', inputSchema: { type: 'object' }, permissionLevel: 'write',
    async execute() { await writeFile(file, 'completed'); return { content: 'Write completed.' }; } };
  const stream = queryLoop(config(cwd, { abortSignal: controller.signal, hooks: { PostToolUse: [{ hooks: [async (_input, _id, { signal }) => {
    hookEntered(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return {};
  }] }] } }), provider(request => frames(request, [call('write-once', tool.name)], 'tool_use')), [tool], 'start',
  { onToolResultMessage: message => recorded.push(message) });
  const finished = drain(stream); await entered; controller.abort(); const events = await finished;
  assert.equal(await readFile(file, 'utf8'), 'completed');
  assert.ok(recorded.some(frame => frame.message.content.some(block => block.type === 'tool_result' && block.content === 'Write completed.')));
  assert.equal(events.at(-1).is_error, true); assert.equal(events.at(-1).result, 'Operation was aborted');
  assert.ok(events.some(event => event.type === 'user' && event.message.content.some(block => block.type === 'text' && block.text === '[Interrupted by tool use]')));
});

test('terminal turn and budget limits do not invent assistant failure answers', deadline, async t => {
  const cwd = await temporary(t);
  for (const [overrides, subtype, stop] of [[{ maxTurns: 0 }, 'error_max_turns', 'max_turns'], [{ maxBudgetUsd: 0 }, 'error_max_budget_usd', 'max_budget']]) {
    const requests = []; const events = await drain(queryLoop(config(cwd, overrides), provider(request => frames(request, [text('unexpected')]), requests), [], 'start'));
    assert.equal(requests.length, 0); assert.equal(events.some(event => event.type === 'assistant'), false);
    assert.equal(events.at(-1).subtype, subtype); assert.equal(events.at(-1).stop_reason, stop); assert.equal(events.at(-1).num_turns, 0);
  }
});

test('an already interrupted loop still emits init and an explicit cancellation result', deadline, async t => {
  const cwd = await temporary(t); const controller = new AbortController(); controller.abort(); const requests = [];
  const events = await drain(queryLoop(config(cwd, { abortSignal: controller.signal }), provider(request => frames(request, [text('unexpected')]), requests), [], 'start'));
  assert.equal(events[0].subtype, 'init'); assert.equal(requests.length, 0);
  assert.equal(events.at(-1).result, 'Operation was aborted');
  assert.ok(events.some(event => event.type === 'user' && event.message.content[0].text === '[Interrupted by user]'));
});

test('a changed supplied tool pool replaces exact declarations without adding builtins', deadline, async t => {
  const cwd = await temporary(t); let refresh = 0; let used = false;
  const before = { name: 'Old', description: 'Old.', inputSchema: { type: 'object' }, permissionLevel: 'readonly', async execute() { throw new Error('Old tool ran'); } };
  const after = { ...before, name: 'New', description: 'New.', async execute() { used = true; return { content: 'new result' }; } };
  const events = await drain(queryLoop(config(cwd), provider((request, index) => {
    assert.deepEqual(request.tools.map(tool => tool.name), ['New']);
    return frames(request, index === 1 ? [call('new', 'New')] : [text('Done.')], index === 1 ? 'tool_use' : 'end_turn');
  }), [before], 'start', { getToolState: () => ++refresh === 1 ? [after] : undefined }));
  assert.equal(used, true); assert.deepEqual(events[0].tools, ['Old']); assert.equal(events.at(-1).is_error, false);
});


test('each completed tool result is visible before a later retry while the journal retains one batch', deadline, async t => {
  const cwd = await temporary(t);
  const effect = join(cwd, 'effects.jsonl');
  const outcomes = [
    { content: 'first output' },
    { content: 'image output', images: [{ mimeType: 'image/png', data: 'AA==' }] },
    { content: 'fixture refusal', isError: true },
    { content: 'fourth output' },
  ];
  const ids = outcomes.map((_, index) => `batch-${index}`);
  const events = [];
  let executions = 0, requests = 0, restored = false;
  const model = {
    id: 'fixture', name: 'Fixture', capabilities: () => capabilities,
    async createMessage() { throw new Error('Unexpected summary request'); },
    async *createMessageStream(request) {
      requests++;
      if (requests === 1) {
        yield* frames(request, ids.map((id, index) => call(id, 'InspectFixture', { index })), 'tool_use');
        return;
      }
      const resultMessages = request.messages.filter(message => Array.isArray(message.content)
        && message.content.some(block => block.type === 'tool_result' && ids.includes(block.tool_use_id)));
      assert.equal(resultMessages.length, 1);
      assert.deepEqual(resultMessages[0].content.map(block => block.tool_use_id), ids);
      assert.equal(resultMessages[0].content[2].is_error, true);
      assert.equal(resultMessages[0].content[1].content[1].type, 'image');
      assert.equal(executions, 4);
      if (!restored) {
        const delivered = events.filter(event => event.type === 'user'
          && event.message.content.some(block => block.type === 'tool_result'));
        assert.equal(delivered.length, 4);
        assert.ok(delivered.every(event => event.message.content.length === 1 && !event.message.toolContext));
        assert.deepEqual(delivered.map(event => event.message.content[0].tool_use_id), ids);
        yield { type: 'retry', attempt: 1, maxRetries: 10, delayMs: 0, status: 503, message: 'Fixture retry before content' };
      }
      yield* frames(request, [text('All outcomes retained.')]);
    },
  };
  const options = { model: 'fixture', provider: model, cwd, env: { HOME: cwd, CLAUDE_CONFIG_DIR: join(cwd, 'state') },
    collaboration: false, tools: [], systemPrompt: 'Fixture instructions.', settingSources: [],
    permissionMode: 'bypassPermissions', thinking: { type: 'disabled' },
    turnEndChecks: { openWork: false, completion: false },
    customTools: [{ name: 'InspectFixture', description: 'Inspect a fixture.', inputSchema: { type: 'object' },
      permissionLevel: 'none', isConcurrencySafe: () => true,
      async execute(input) { executions++; await appendFile(effect, `${input.index}\n`); return outcomes[input.index]; } }],
  };
  let session = await createSession(options);
  try {
    await session.send('Inspect the four fixtures.');
    for await (const event of session.stream()) events.push(event);
    assert.equal(events.findLast(event => event.type === 'result').is_error, false);
    assert.equal(events.filter(event => event.subtype === 'api_retry').length, 1);
    await session[Symbol.asyncDispose]();
    const id = session.sessionId;
    const path = join(cwd, 'state', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
    const journal = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const batches = journal.filter(record => Array.isArray(record.message?.content)
      && record.message.content.some(block => block.type === 'tool_result' && ids.includes(block.tool_use_id)));
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].message.content.map(block => block.tool_use_id), ids);
    const delivered = events.filter(event => event.type === 'user'
      && event.message.content.some(block => block.type === 'tool_result'));
    assert.ok(delivered.every(event => event.uuid === batches[0].uuid));
    assert.deepEqual((await readFile(effect, 'utf8')).trim().split('\n').sort(), ['0', '1', '2', '3']);
    restored = true;
    session = await createSession({ ...options, resume: id, strictResume: true });
    await session.send('Review the recorded outcomes without repeating them.');
    const replay = await drain(session.stream());
    assert.equal(replay.findLast(event => event.type === 'result').is_error, false);
    assert.equal(executions, 4);
    assert.equal(requests, 3);
  } finally { await session[Symbol.asyncDispose](); }
});
