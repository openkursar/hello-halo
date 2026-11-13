import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const { createSession } = await import(pathToFileURL(join(compiled, 'native/session.js')).href);

function fixture(script) {
  let step = 0;
  return {
    id: 'discovery-fixture', name: 'Discovery fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false, pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { throw new Error('Unexpected summary call'); },
    async *createMessageStream(request) {
      const block = await script(request, ++step);
      yield { type: 'message_start', id: `response-${step}`, model: request.model, usage: { input_tokens: 30, output_tokens: 0 } };
      yield { type: 'content_block_start', index: 0, content_block: block };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: block.type === 'tool_use' ? 'tool_use' : 'end_turn', usage: { output_tokens: 5 } };
      yield { type: 'message_stop' };
    },
  };
}
async function consume(session) {
  const events = [];
  for await (const event of session.stream()) events.push(event);
  assert.equal(events.filter(event => event.type === 'result').at(-1)?.subtype, 'success', JSON.stringify(events));
  assert.equal(events.at(-1)?.state, 'idle');
  assert.ok(events.every(event => !event.message?.toolContext));
  return events;
}

test('Rust discovery grants only delivered definitions and restores exact CallTool history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'halo-native-discovery-'));
  const file = join(root, 'effects.txt');
  const state = join(root, 'state');
  const rawArguments = '{ "value" : "delivered-once" }';
  let session;
  let resumed;
  let effects = 0;
  const server = {
    listTools: () => [{ name: 'record', description: 'Record one supplied value.', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }],
    async callTool(name, input) {
      assert.equal(name, 'record'); effects++;
      await writeFile(file, input.value);
      return { content: [{ type: 'text', text: `Recorded ${input.value}` }] };
    },
  };
  const options = {
    model: 'fixture', cwd: root, env: { HOME: root, CLAUDE_CONFIG_DIR: state }, tools: [], collaboration: false,
    systemPrompt: 'Local discovery fixture', permissionMode: 'bypassPermissions', thinking: { type: 'disabled' }, includePartialMessages: true,
    mcpServers: { records: { type: 'sdk', name: 'records', instance: server } },
    toolDiscovery: { services: { records: { identity: 'fixture:records', loading: 'deferred', summary: 'Record supplied values' } } },
  };
  try {
    const provider = fixture(async (request, step) => {
      assert.deepEqual(request.tools.map(tool => tool.name), ['ToolSearch', 'CallTool']);
      assert.ok(request.messages.every(message => !message.toolContext));
      if (step === 1) return { type: 'tool_use', id: 'search', name: 'ToolSearch', input: { query: 'select:mcp__records__record' } };
      if (step === 2) {
        assert.equal(effects, 0);
        assert.ok(request.messages.some(message => JSON.stringify(message.content).includes('arguments_schema')));
        return { type: 'tool_use', id: 'record', name: 'CallTool', input: { tool: 'mcp__records__record', arguments: rawArguments } };
      }
      assert.equal(effects, 1);
      assert.equal(await readFile(file, 'utf8'), 'delivered-once');
      const call = request.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).find(block => block.id === 'record');
      assert.deepEqual(call, { type: 'tool_use', id: 'record', name: 'CallTool', input: { tool: 'mcp__records__record', arguments: rawArguments } });
      return { type: 'text', text: 'Recorded and verified.' };
    });
    session = await createSession({ ...options, provider });
    await session.send('Find the record tool and record one value.');
    const events = await consume(session);
    const publicCall = events.filter(event => event.type === 'assistant').flatMap(event => event.message.content).find(block => block.id === 'record');
    assert.equal(publicCall.name, 'mcp__records__record');
    assert.deepEqual(publicCall.input, { value: 'delivered-once' });
    const sessionId = session.sessionId;
    await session[Symbol.asyncDispose](); session = undefined;
    const path = join(state, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
    const lines = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(lines.some(line => line.message?.toolContext?.baseline));
    assert.ok(lines.some(line => line.message?.toolContext?.calls));
    resumed = await createSession({ ...options, resume: sessionId, strictResume: true, provider: fixture(async request => {
      assert.equal(effects, 1);
      assert.equal(await readFile(file, 'utf8'), 'delivered-once');
      const call = request.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).find(block => block.id === 'record');
      assert.equal(call.name, 'CallTool'); assert.equal(call.input.arguments, rawArguments);
      return { type: 'text', text: 'Resumed without replay.' };
    }) });
    await resumed.send('Continue from the saved result.'); await consume(resumed);
    await resumed[Symbol.asyncDispose](); resumed = undefined;
    assert.equal(effects, 1);
    const broken = lines.find(line => line.message?.toolContext?.discoveries);
    broken.message.toolContext.discoveries[0].definitions[0].definition.description = 'tampered';
    await writeFile(path, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
    await assert.rejects(createSession({ ...options, resume: sessionId, strictResume: true, provider: fixture(async () => { throw new Error('Damaged history must not execute'); }) }), /incomplete/);
    assert.equal(effects, 1);
  } finally {
    await session?.[Symbol.asyncDispose](); await resumed?.[Symbol.asyncDispose]();
    await rm(root, { recursive: true, force: true });
  }
});

function streamedCallInputs(provider) {
  const stream = provider.createMessageStream.bind(provider);
  provider.createMessageStream = async function* (request) {
    for await (const event of stream(request)) {
      if (event.type === 'content_block_start' && typeof event.content_block.rawInput === 'string') {
        const { rawInput, ...content_block } = event.content_block;
        yield { ...event, content_block };
        yield { type: 'input_json_delta', index: event.index, partialJson: rawInput };
      } else yield event;
    }
  };
  return provider;
}

function messageBlocks(request) {
  return request.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
}

test('discovered native calls accept object and recovered inputs while retaining their wrappers without replay', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'halo-native-discovery-inputs-'));
  const file = join(root, 'effects.json');
  const state = join(root, 'state');
  const target = 'mcp__records__record';
  const objectInput = { tool: target, arguments: { value: 'object-once' } };
  const rawInput = `{"tool":"${target}","arguments":{"value":"raw-once",},}`;
  const legacyInput = { tool: target, arguments: '{ "value" : "legacy-once" }' };
  const effects = [];
  const requests = [];
  let session;
  let resumed;
  const server = {
    listTools: () => [{ name: 'record', description: 'Persist a supplied value exactly once.',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }],
    async callTool(name, input) {
      assert.equal(name, 'record');
      effects.push(input.value);
      await writeFile(file, JSON.stringify(effects));
      return { content: [{ type: 'text', text: `Recorded ${input.value}` }] };
    },
  };
  const options = {
    model: 'fixture', cwd: root, env: { HOME: root, CLAUDE_CONFIG_DIR: state }, tools: [], collaboration: false,
    systemPrompt: 'Keep the native discovery contract stable.', permissionMode: 'bypassPermissions',
    thinking: { type: 'disabled' }, turnEndChecks: { openWork: false, completion: false }, maxTurns: 8,
    mcpServers: { records: { type: 'sdk', name: 'records', instance: server } },
    toolDiscovery: { services: { records: { identity: 'fixture:input-contract', loading: 'deferred', summary: 'Record values' } } },
  };
  const assertWrappers = request => {
    const blocks = messageBlocks(request);
    assert.deepEqual(blocks.find(block => block.id === 'object-call'), { type: 'tool_use', id: 'object-call', name: 'CallTool', input: objectInput });
    const raw = blocks.find(block => block.id === 'raw-call');
    assert.equal(raw?.name, 'CallTool');
    assert.equal(raw.input.tool, target);
    assert.deepEqual(raw.input.arguments, { value: 'raw-once' });
    assert.deepEqual(blocks.find(block => block.id === 'legacy-call'), { type: 'tool_use', id: 'legacy-call', name: 'CallTool', input: legacyInput });
    assert.equal(blocks.filter(block => block.type === 'tool_use' && block.name === target).length, 0);
  };
  try {
    const provider = streamedCallInputs(fixture(async (request, step) => {
      requests.push(structuredClone(request));
      assert.deepEqual(request.tools, requests[0].tools);
      assert.deepEqual(request.systemPrompt, requests[0].systemPrompt);
      assert.deepEqual(request.messages.slice(0, requests[0].messages.length), requests[0].messages);
      const invocation = request.tools.find(tool => tool.name === 'CallTool');
      assert.equal(invocation.input_schema.properties.arguments.type, 'object');
      assert.deepEqual(request.tools.map(tool => tool.name), ['ToolSearch', 'CallTool']);
      if (step === 1) return { type: 'tool_use', id: 'input-search', name: 'ToolSearch', input: { query: `select:${target}` } };
      if (step === 2) {
        const result = messageBlocks(request).find(block => block.tool_use_id === 'input-search');
        const payload = JSON.parse(result.content);
        assert.equal(payload.invoke_via, 'CallTool');
        assert.equal(payload.targets[0].tool, target);
        assert.deepEqual(payload.targets[0].arguments_schema.required, ['value']);
        assert.equal(Object.hasOwn(payload, 'tools'), false);
        return { type: 'tool_use', id: 'object-call', name: 'CallTool', input: objectInput };
      }
      if (step === 3) return { type: 'tool_use', id: 'raw-call', name: 'CallTool', input: {}, rawInput };
      if (step === 4) return { type: 'tool_use', id: 'legacy-call', name: 'CallTool', input: legacyInput };
      assert.equal(step, 5);
      assert.deepEqual(effects, ['object-once', 'raw-once', 'legacy-once']);
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), effects);
      assertWrappers(request);
      return { type: 'text', text: 'All three records are verified.' };
    }));
    session = await createSession({ ...options, provider });
    await session.send('Discover the recorder and store the three values.');
    await consume(session);
    const sessionId = session.sessionId;
    await session[Symbol.asyncDispose](); session = undefined;
    const path = join(state, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
    const lines = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const origin = lines.flatMap(line => line.message?.toolContext?.calls ?? []).find(call => call.id === 'raw-call');
    assert.equal(origin.rawInput, rawInput);
    resumed = await createSession({ ...options, resume: sessionId, strictResume: true, provider: fixture(async request => {
      assertWrappers(request);
      assert.deepEqual(effects, ['object-once', 'raw-once', 'legacy-once']);
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), effects);
      return { type: 'text', text: 'Restored the committed records without replay.' };
    }) });
    await resumed.send('Review the retained outcome.');
    await consume(resumed);
    assert.deepEqual(effects, ['object-once', 'raw-once', 'legacy-once']);
    assert.equal(requests.length, 5);
  } finally {
    await session?.[Symbol.asyncDispose](); await resumed?.[Symbol.asyncDispose]();
    await rm(root, { recursive: true, force: true });
  }
});

test('text examples never execute and invalid native calls stop after bounded same-turn feedback', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'halo-native-discovery-refusal-'));
  const target = 'mcp__records__record';
  const effects = [];
  const requests = [];
  let session;
  const example = `<CallTool>{"tool":"${target}","arguments":{"value":"native-once"}}</CallTool>`;
  const requiredInput = { tool: target, arguments: {} };
  const feedback = (request, id) => {
    const result = messageBlocks(request).find(block => block.tool_use_id === id);
    assert.equal(result?.is_error, true);
    assert.match(result.content, /Nothing was executed\./);
    assert.match(result.content, /CallTool input/);
    assert.match(result.content, /"tool"/);
    assert.match(result.content, /"arguments"/);
    return result.content;
  };
  try {
    const provider = fixture(async (request, step) => {
      requests.push(structuredClone(request));
      if (step === 1) return { type: 'tool_use', id: 'refusal-search', name: 'ToolSearch', input: { query: `select:${target}` } };
      if (step === 2) return { type: 'text', text: `Documentation example: ${example}\nThis quoted example describes a call.` };
      if (step === 3) {
        assert.deepEqual(effects, []);
        return { type: 'tool_use', id: 'valid-once', name: 'CallTool', input: { tool: target, arguments: { value: 'native-once' } } };
      }
      if (step === 4) {
        assert.deepEqual(effects, ['native-once']);
        return { type: 'text', text: `The native operation above completed once. Its text representation is ${example}\nThis is the recorded result.` };
      }
      if (step === 5) return { type: 'tool_use', id: 'missing-target', name: 'CallTool', input: { arguments: { value: 'must-not-run' } } };
      if (step === 6) {
        feedback(request, 'missing-target');
        assert.deepEqual(effects, ['native-once']);
        return { type: 'tool_use', id: 'missing-required', name: 'CallTool', input: requiredInput };
      }
      assert.equal(step, 7, 'Invalid input must not create an unbounded correction loop.');
      assert.match(feedback(request, 'missing-required'), /value/);
      assert.deepEqual(effects, ['native-once']);
      return { type: 'tool_use', id: 'repeat-invalid', name: 'CallTool', input: requiredInput };
    });
    session = await createSession({ model: 'fixture', provider, cwd: root, env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'state') },
      tools: [], collaboration: false, persistSession: false, systemPrompt: 'Use native invocations for execution.',
      permissionMode: 'bypassPermissions', thinking: { type: 'disabled' }, maxTurns: 8,
      turnEndChecks: { openWork: false, completion: false },
      mcpServers: { records: { type: 'sdk', name: 'records', instance: {
        listTools: () => [{ name: 'record', description: 'Record the required value.',
          inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }],
        async callTool(name, input) { assert.equal(name, 'record'); effects.push(input.value); return { content: [{ type: 'text', text: 'Recorded once.' }] }; },
      } } },
      toolDiscovery: { services: { records: { identity: 'fixture:refusal-contract', loading: 'deferred', summary: 'Record one value' } } },
    });
    await session.send('Discover the target and show an ordinary documentation example.');
    await consume(session);
    assert.deepEqual(effects, []);
    assert.equal(requests.length, 2);
    await session.send('Now invoke the native target once and quote its representation.');
    await consume(session);
    assert.deepEqual(effects, ['native-once']);
    assert.equal(requests.length, 4);
    await session.send('Exercise invalid input without performing an operation.');
    const failed = [];
    for await (const event of session.stream()) failed.push(event);
    const results = failed.filter(event => event.type === 'result');
    assert.equal(results.length, 1);
    assert.equal(results[0].is_error, true);
    assert.match(JSON.stringify(results[0]), /incomplete|format recovery limit/i);
    assert.equal(failed.at(-1)?.state, 'idle');
    assert.equal(requests.length, 7);
    assert.deepEqual(effects, ['native-once']);
  } finally {
    await session?.[Symbol.asyncDispose]();
    await rm(root, { recursive: true, force: true });
  }
});
