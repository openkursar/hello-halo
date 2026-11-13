import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createModelServer, sendSse, completionEvents } from './fixtures/model-server.mjs';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const { AnthropicProvider, OpenAiCompatProvider, createSession } = await import(pathToFileURL(join(compiled, 'index.js')).href);
const deadline = { timeout: 15_000 };
const modelProvider = endpoint => new OpenAiCompatProvider({ id: 'fixture', name: 'Fixture', apiKey: 'fixture-only', baseUrl: `${endpoint.url}/v1` });
const request = { model: 'fixture', messages: [{ role: 'user', content: 'Run the fixture.' }], maxTokens: 128, thinking: { type: 'disabled' } };
const complete = (response, message, reason = 'tool_calls', input = 17, output = 3) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ id: 'fixture', model: 'fixture', choices: [{ message, finish_reason: reason }],
    usage: { prompt_tokens: input, completion_tokens: output } }));
};
const toolCall = (id, args) => ({ id, type: 'function', function: { name: 'RecordFixture', arguments: args } });
async function drain(session, prompt) {
  await session.send(prompt);
  const events = [];
  for await (const event of session.stream()) events.push(event);
  assert.equal(events.filter(event => event.type === 'result').length, 1);
  assert.equal(events.at(-1).state, 'idle');
  return { events, result: events.findLast(event => event.type === 'result') };
}
function options(root, provider, extra = {}) {
  return { model: 'fixture', provider, cwd: root, env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'state') },
    tools: [], skillCatalog: [], settingSources: [], collaboration: false, persistSession: false,
    systemPrompt: 'Fixture instructions.', thinking: { type: 'disabled' }, permissionMode: 'bypassPermissions', maxTurns: 6,
    turnEndChecks: { openWork: false, completion: false }, ...extra };
}

test('complete OpenAI responses preserve structured arguments instead of substituting an empty object', deadline, async t => {
  const payload = { value: '中文 "quoted"\\\n', mode: 'fixture' };
  const endpoint = await createModelServer((_request, response, body) => {
    assert.equal(body.stream, false);
    complete(response, { content: null, tool_calls: [toolCall('record', payload)] });
  });
  t.after(() => endpoint.close());
  const response = await modelProvider(endpoint).createMessage(request);
  assert.deepEqual(response.content.find(block => block.type === 'tool_use').input, payload);
  assert.equal(response.usage.input_tokens, 17);
  assert.equal(response.usage.output_tokens, 3);
  assert.equal(endpoint.requests.length, 1);
});

for (const args of ['{', '[]']) test(`complete OpenAI responses with invalid argument ${JSON.stringify(args)} expose no executable partial batch`, deadline, async t => {
  const endpoint = await createModelServer((_request, response) => complete(response, {
    content: 'I will record the fixture.', tool_calls: [toolCall('valid', '{"value":"valid"}'), toolCall('invalid', args)],
  }, 'stop'));
  t.after(() => endpoint.close());
  const response = await modelProvider(endpoint).createMessage(request);
  assert.equal(response.content.filter(block => block.type === 'tool_use').length, 0);
  assert.equal(typeof response.unreadableToolCall, 'string');
  assert.equal(response.usage.input_tokens, 17);
  assert.equal(response.usage.output_tokens, 3);
  assert.equal(endpoint.requests.length, 1);
});

test('complete refusal text stays literal even for a model with think-tag adaptation', deadline, async t => {
  const refusal = 'Declined: <think>literal text</think>.';
  const endpoint = await createModelServer((_request, response) => complete(response, { content: null, refusal }, 'stop'));
  t.after(() => endpoint.close());
  const response = await modelProvider(endpoint).createMessage({ ...request, model: 'qwen-fixture' });
  assert.deepEqual(response.content, [{ type: 'text', text: refusal }]);
  assert.equal(endpoint.requests.length, 1);
});

test('persistent unreadable JSON-mode calls end with an error and no execution despite nonempty prose', deadline, async t => {
  const root = await mkdtemp(join(tmpdir(), 'halo-unreadable-format-'));
  let session, effects = 0;
  const endpoint = await createModelServer((_request, response) => {
    assert.ok(endpoint.requests.length <= 3);
    sendSse(response, completionEvents('openai', { content: 'I will record the fixture.\n```json [1,]```' }));
  });
  t.signal.addEventListener('abort', () => session?.close(), { once: true });
  t.after(async () => { await session?.[Symbol.asyncDispose](); await endpoint.close(); await rm(root, { recursive: true, force: true }); });
  session = await createSession(options(root, modelProvider(endpoint), { toolCallingMode: 'json', customTools: [
    { name: 'RecordFixture', description: 'Record a fixture.', inputSchema: { type: 'object' }, permissionLevel: 'write',
      async execute() { effects++; await appendFile(join(root, 'effects.txt'), 'wrong\n'); return { content: 'Recorded.' }; } },
  ] }));
  const { result } = await drain(session, 'Record the fixture.');
  assert.equal(endpoint.requests.length, 3);
  assert.equal(effects, 0);
  assert.equal(result.is_error, true);
  assert.match(result.result, /unreadable|format/i);
  assert.equal(result.usage.input_tokens, 51);
  assert.equal(result.usage.output_tokens, 9);
});

for (const mode of ['json', 'xml']) test(`${mode} mode retains ordinary JSON answers without tool retries`, deadline, async t => {
  const root = await mkdtemp(join(tmpdir(), 'halo-json-answer-'));
  let session, effects = 0;
  const answers = ['```json []```', '```json [{"value":1}]```', '```json [{"name":"Alice"}]```'];
  let answer = answers[0];
  const endpoint = await createModelServer((_request, response) => sendSse(response, completionEvents('openai', { content: answer })));
  t.signal.addEventListener('abort', () => session?.close(), { once: true });
  t.after(async () => { await session?.[Symbol.asyncDispose](); await endpoint.close(); await rm(root, { recursive: true, force: true }); });
  session = await createSession(options(root, modelProvider(endpoint), { toolCallingMode: mode, customTools: [
    { name: 'RecordFixture', description: 'Record a fixture.', inputSchema: { type: 'object' }, permissionLevel: 'write',
      async execute() { effects++; return { content: 'Unexpected execution.' }; } },
  ] }));
  for (const expected of answers) {
    answer = expected;
    const requestsBefore = endpoint.requests.length;
    const { result } = await drain(session, 'Return the fixture data as JSON.');
    assert.equal(result.is_error, false);
    assert.equal(result.result, expected);
    assert.equal(endpoint.requests.length - requestsBefore, 1);
    assert.equal(result.usage.input_tokens, 17);
  }
  assert.equal(effects, 0);
});

for (const mode of ['json', 'xml']) test(`${mode} argument recovery never executes substituted objects and retains the repaired values`, deadline, async t => {
  const root = await mkdtemp(join(tmpdir(), 'halo-format-arguments-'));
  let session;
  const effects = [];
  const repaired = { payload: { __haloSdkNativeNumber: 'NaN' } };
  const bad = mode === 'json'
    ? '```json [{"name":"RecordFixture","params":{"payload":{"value":"partial"}}},{"name":"RecordFixture","params":"wrong"}]```'
    : '<RecordFixture><payload>1e400</payload></RecordFixture>';
  const good = mode === 'json'
    ? `\`\`\`json ${JSON.stringify([{ name: 'RecordFixture', params: repaired }])}\`\`\``
    : `<RecordFixture><payload>${JSON.stringify(repaired.payload)}</payload></RecordFixture>`;
  const endpoint = await createModelServer((_request, response) => {
    assert.ok(endpoint.requests.length <= 3);
    const content = endpoint.requests.length === 1 ? bad : endpoint.requests.length === 2 ? good : 'The corrected fixture was recorded.';
    sendSse(response, completionEvents('openai', { content }));
  });
  t.signal.addEventListener('abort', () => session?.close(), { once: true });
  t.after(async () => { await session?.[Symbol.asyncDispose](); await endpoint.close(); await rm(root, { recursive: true, force: true }); });
  session = await createSession(options(root, modelProvider(endpoint), { toolCallingMode: mode, customTools: [
    { name: 'RecordFixture', description: 'Record fixture values.', inputSchema: { type: 'object', properties: { payload: { type: 'object' } } }, permissionLevel: 'write',
      async execute(input) { effects.push(input); await appendFile(join(root, 'effects.txt'), `${JSON.stringify(input)}\n`); return { content: 'Recorded.' }; } },
  ] }));
  const { result } = await drain(session, 'Record the fixture.');
  assert.equal(result.is_error, false);
  assert.deepEqual(effects, [repaired]);
  assert.equal(endpoint.requests.length, 3);
  assert.match(JSON.stringify(endpoint.requests[1].body.messages), /unreadable|params|JSON/i);
  assert.equal((await readFile(join(root, 'effects.txt'), 'utf8')).trim(), JSON.stringify(repaired));
  assert.ok(JSON.stringify(endpoint.requests[2].body.messages).includes('__haloSdkNativeNumber'));
});

for (const protocol of ['anthropic', 'openai']) for (const location of ['top', 'nested']) test(`${protocol} literal business markers at ${location} survive policy, execution, provider history and resume`, deadline, async t => {
  const root = await mkdtemp(join(tmpdir(), 'halo-literal-markers-'));
  const payload = location === 'top'
    ? { value: 'literal', __haloSdkNativeUndefined: true, __haloSdkNativeNumber: 'NaN' }
    : { value: 'literal', nested: [{ __haloSdkNativeUndefined: true }, { __haloSdkNativeNumber: 'NaN' }] };
  const approved = { ...payload, value: 'approved' };
  let session, observed, permissionObserved, hookObserved, effects = 0;
  const endpoint = await createModelServer((_request, response) => {
    if (endpoint.requests.length === 1) {
      if (protocol === 'openai') sendSse(response, [
        { id: 'fixture', model: 'fixture', choices: [{ delta: { tool_calls: [{ index: 0, ...toolCall('record', JSON.stringify(payload)) }] } }] },
        { choices: [{ finish_reason: 'tool_calls' }], usage: { prompt_tokens: 17, completion_tokens: 3 } },
      ]);
      else {
        const events = completionEvents(protocol, [{ type: 'tool_use', id: 'record', name: 'RecordFixture', input: {} }]);
        events.splice(2, 0, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(payload) } });
        events.at(-2).delta.stop_reason = 'tool_use';
        sendSse(response, events);
      }
    } else sendSse(response, completionEvents(protocol, protocol === 'openai' ? { content: 'The literal fields were retained.' }
      : [{ type: 'text', text: 'The literal fields were retained.' }]));
  });
  t.signal.addEventListener('abort', () => session?.close(), { once: true });
  t.after(async () => { await session?.[Symbol.asyncDispose](); await endpoint.close(); await rm(root, { recursive: true, force: true }); });
  const provider = protocol === 'openai' ? modelProvider(endpoint) : new AnthropicProvider({ apiKey: 'fixture-only', baseUrl: endpoint.url });
  const config = options(root, provider, { persistSession: true, permissionMode: 'default',
    canUseTool: async (_name, input) => { permissionObserved = input; return { behavior: 'allow', updatedInput: approved }; },
    hooks: { PreToolUse: [{ matcher: 'RecordFixture', hooks: [async input => { hookObserved = input.tool_input; return {}; }] }] },
    customTools: [
    { name: 'RecordFixture', description: 'Record fixture fields.', inputSchema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } } },
      permissionLevel: 'write', async execute(input) { effects++; observed = input; await appendFile(join(root, 'effects.txt'), `${JSON.stringify(input)}\n`); return { content: JSON.stringify(input) }; } },
  ] });
  session = await createSession(config);
  assert.equal((await drain(session, 'Record the literal fields.')).result.is_error, false);
  assert.equal(effects, 1);
  assert.deepEqual(hookObserved, payload);
  assert.deepEqual(permissionObserved, payload);
  assert.deepEqual(observed, approved);
  const wireInput = body => protocol === 'openai'
    ? JSON.parse(body.messages.flatMap(message => message.tool_calls ?? []).find(call => call.id === 'record').function.arguments)
    : body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).find(block => block.type === 'tool_use' && block.id === 'record').input;
  assert.deepEqual(wireInput(endpoint.requests[1].body), payload);
  assert.deepEqual(JSON.parse((await readFile(join(root, 'effects.txt'), 'utf8')).trim()), approved);
  const id = session.sessionId;
  await session[Symbol.asyncDispose]();
  const journal = join(root, 'state', 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
  const records = (await readFile(journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const stored = records.flatMap(record => Array.isArray(record.message?.content) ? record.message.content : []).find(block => block.type === 'tool_use');
  assert.deepEqual(stored.input, payload);
  session = await createSession({ ...config, resume: id, strictResume: true });
  assert.equal((await drain(session, 'Review the stored fields without repeating actions.')).result.is_error, false);
  assert.equal(effects, 1);
  assert.equal(endpoint.requests.length, 3);
  assert.deepEqual(wireInput(endpoint.requests[2].body), payload);
});

test('manual compaction rejects unreadable complete calls, repairs the summary and counts both responses once', deadline, async t => {
  const root = await mkdtemp(join(tmpdir(), 'halo-complete-summary-'));
  let session, summaries = 0, effects = 0;
  const endpoint = await createModelServer((_request, response, body) => {
    if (body.stream) { sendSse(response, completionEvents('openai', { content: 'Observation retained.' })); return; }
    summaries++;
    assert.ok(summaries <= 2);
    if (summaries === 1) complete(response, { content: 'I will invoke the fixture.', tool_calls: [toolCall('invalid-summary', '{')] }, 'stop');
    else complete(response, { content: 'VALID_HANDOVER: earlier observations retained; inspect the original transcript for details.' }, 'stop', 19, 5);
  });
  t.signal.addEventListener('abort', () => session?.close(), { once: true });
  t.after(async () => { await session?.[Symbol.asyncDispose](); await endpoint.close(); await rm(root, { recursive: true, force: true }); });
  const config = options(root, modelProvider(endpoint), { persistSession: true, customTools: [
    { name: 'RecordFixture', description: 'Record a fixture.', inputSchema: { type: 'object' }, permissionLevel: 'write', async execute() { effects++; return { content: 'Wrong summary execution.' }; } },
  ] });
  session = await createSession(config);
  for (let index = 0; index < 8; index++) assert.equal((await drain(session, `Observation ${index}: ${'earlier verified evidence '.repeat(400)}`)).result.is_error, false);
  await drain(session, 'LATEST_CONSTRAINT: do not repeat completed actions.');
  const compacted = await drain(session, '/compact');
  assert.equal(compacted.result.is_error, false);
  assert.equal(summaries, 2);
  assert.equal(effects, 0);
  assert.equal(compacted.result.usage.input_tokens, 36);
  assert.equal(compacted.result.usage.output_tokens, 8);
  assert.equal(compacted.events.filter(event => event.subtype === 'compact_boundary').length, 1);
  const id = session.sessionId;
  await session[Symbol.asyncDispose]();
  session = await createSession({ ...config, resume: id, strictResume: true });
  assert.equal((await drain(session, 'Review the retained requirements.')).result.is_error, false);
  assert.match(JSON.stringify(endpoint.requests.at(-1).body.messages), /VALID_HANDOVER/);
  assert.match(JSON.stringify(endpoint.requests.at(-1).body.messages), /LATEST_CONSTRAINT/);
  assert.equal(effects, 0);
});
