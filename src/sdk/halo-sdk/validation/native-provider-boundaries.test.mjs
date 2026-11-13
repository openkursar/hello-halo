import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { createModelServer, sendSse, completionEvents } from './fixtures/model-server.mjs';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const { AnthropicProvider, OpenAiCompatProvider, createSession } = await import(pathToFileURL(join(compiled, 'index.js')).href);
const deadline = { timeout: 15_000 };
const answer = (protocol, text) => protocol === 'openai' ? { content: text } : [{ type: 'text', text }];

async function sessionFixture(t, protocol, handler, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'halo-provider-boundary-'));
  const endpoint = await createModelServer((_request, response, body) => handler(response, body, endpoint.requests.length));
  let session;
  t.after(async () => { await session?.[Symbol.asyncDispose](); await endpoint.close(); await rm(root, { recursive: true, force: true }); });
  t.signal.addEventListener('abort', () => session?.close(), { once: true });
  const provider = protocol === 'anthropic' ? new AnthropicProvider({ apiKey: 'fixture-only', baseUrl: endpoint.url })
    : new OpenAiCompatProvider({ id: 'fixture', name: 'Fixture', apiKey: 'fixture-only', baseUrl: `${endpoint.url}/v1` });
  session = await createSession({ model: 'fixture', provider, cwd: root,
    env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'state') },
    tools: [], skillCatalog: [], settingSources: [], collaboration: false, persistSession: false,
    systemPrompt: 'Fixture instructions.', thinking: { type: 'disabled' }, maxTurns: 6,
    turnEndChecks: { completion: false, openWork: false }, ...overrides });
  return { session, endpoint, root, async send() {
    await session.send('Return the fixture answer.');
    const events = [];
    for await (const event of session.stream()) events.push(event);
    assert.equal(events.filter(event => event.type === 'result').length, 1);
    assert.equal(events.at(-1).state, 'idle');
    return { events, result: events.findLast(event => event.type === 'result') };
  } };
}

function ended(protocol, content, reason) {
  const events = completionEvents(protocol, content);
  if (protocol === 'openai') events.at(-1).choices[0].finish_reason = reason;
  else events.at(-2).delta.stop_reason = reason;
  return events;
}

for (const protocol of ['anthropic', 'openai']) {
  for (const text of ['', 'I will call a tool.']) test(`${protocol} recovers a tool-call finish without an actual tool call and text=${Boolean(text)}`, deadline, async t => {
    const f = await sessionFixture(t, protocol, (response, _body, count) => {
      assert.ok(count <= 2);
      sendSse(response, count === 1 ? ended(protocol, answer(protocol, text), protocol === 'openai' ? 'tool_calls' : 'tool_use')
        : completionEvents(protocol, answer(protocol, 'Recovered.')));
    });
    const { result } = await f.send();
    assert.equal(result.is_error, false);
    assert.equal(result.result, 'Recovered.');
    assert.equal(f.endpoint.requests.length, 2);
    assert.equal(f.endpoint.requests[0].rawBody, f.endpoint.requests[1].rawBody);
  });

  for (const reason of protocol === 'openai' ? ['content_filter', 'stop_sequence'] : ['refusal', 'stop_sequence']) {
    test(`${protocol} empty ${reason} stops explicitly without retrying the server`, deadline, async t => {
      const f = await sessionFixture(t, protocol, response => sendSse(response, ended(protocol, answer(protocol, ''), reason)));
      const { result } = await f.send();
      assert.equal(f.endpoint.requests.length, 1);
      assert.equal(result.is_error, true);
      assert.match(result.result, /response|answer/i);
    });
  }

  test(`${protocol} empty output at the length limit stops after bounded existing continuation`, deadline, async t => {
    const f = await sessionFixture(t, protocol, (response, _body, count) => {
      assert.ok(count <= 4);
      sendSse(response, ended(protocol, answer(protocol, ''), protocol === 'openai' ? 'length' : 'max_tokens'));
    });
    const { result } = await f.send();
    assert.equal(f.endpoint.requests.length, 4);
    assert.equal(result.is_error, true);
    assert.equal(result.num_turns, 4);
    assert.equal(result.usage.input_tokens, 68);
    assert.equal(result.usage.output_tokens, 12);
  });

  for (const framing of ['fragmented', 'multiline', 'cr', 'bom', 'no-blank-lines']) {
    test(`${protocol} preserves Unicode and escaped characters with ${framing} SSE`, deadline, async t => {
      const text = '中文🙂e\u0301\n"quoted"\\slash\u0000';
      const f = await sessionFixture(t, protocol, async (response, body, count) => {
        if (count > 1) {
          response.writeHead(400, { 'content-type': 'application/json', 'x-should-retry': 'false' });
          response.end(JSON.stringify({ error: { message: 'A valid fixture stream must not need a retry.' } }));
          return;
        }
        assert.equal(body.stream, true);
        const events = completionEvents(protocol, answer(protocol, text));
        const separator = framing === 'cr' ? '\r' : '\r\n';
        let wire = events.map(event => {
          const lines = framing === 'multiline' ? JSON.stringify(event, null, 2).split('\n') : [JSON.stringify(event)];
          return lines.map(line => `data: ${line}`).join(separator) + separator + (framing === 'no-blank-lines' ? '' : separator);
        }).join('');
        if (framing === 'bom') wire = '\uFEFF' + wire;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        if (framing === 'fragmented') {
          const bytes = Buffer.from(wire);
          for (let offset = 0; offset < bytes.length; offset++) { response.write(bytes.subarray(offset, offset + 1)); await setImmediate(); }
          response.end();
        } else response.end(wire);
      });
      const { result } = await f.send();
      assert.equal(result.is_error, false);
      assert.equal(result.result, text);
      assert.equal(result.usage.input_tokens, 17);
      assert.equal(result.usage.output_tokens, 3);
      assert.equal(f.endpoint.requests.length, 1);
    });
  }

  for (const corruption of ['json', 'utf8', 'non-object']) test(`${protocol} retries ${corruption} corruption without accepting a partial answer`, deadline, async t => {
    const f = await sessionFixture(t, protocol, (response, body, count) => {
      assert.ok(count <= 2);
      if (count === 2) {
        if (body.stream) sendSse(response, completionEvents(protocol, answer(protocol, 'Complete answer.')));
        else { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ id: 'recovered', model: 'fixture',
          content: [{ type: 'text', text: 'Complete answer.' }], stop_reason: 'end_turn', usage: { input_tokens: 17, output_tokens: 3 } })); }
        return;
      }
      const events = completionEvents(protocol, answer(protocol, 'Partial answer.'));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify(events[0])}\n\n`);
      if (corruption === 'json') response.write('data: {"broken": !}\n\n');
      else if (corruption === 'utf8') response.write(Buffer.concat([Buffer.from('data: {"content":"'), Buffer.from([0xff]), Buffer.from('"}\n\n')]));
      else response.write('data: [1, 2, 3]\n\n');
      for (const event of events.slice(1)) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
    const { result } = await f.send();
    assert.equal(result.is_error, false);
    assert.equal(result.result, 'Complete answer.');
    assert.equal(f.endpoint.requests.length, 2);
    assert.deepEqual(f.endpoint.requests[0].body.messages, f.endpoint.requests[1].body.messages);
  });

  test(`${protocol} a malformed tail after an admitted tool retains its effect without replay`, deadline, async t => {
    let release, file, executions = 0;
    const completed = new Promise(resolve => { release = resolve; });
    t.signal.addEventListener('abort', release, { once: true });
    const f = await sessionFixture(t, protocol, async (response, _body, count) => {
      if (count > 1) { sendSse(response, completionEvents(protocol, answer(protocol, 'Recorded once.'))); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = value => response.write(`data: ${JSON.stringify(value)}\n\n`);
      if (protocol === 'openai') {
        emit({ id: 'effect', model: 'fixture', choices: [{ delta: { tool_calls: [{ index: 0, id: 'append', function: { name: 'AppendFixture', arguments: '{}' } }] } }] });
        emit({ choices: [{ finish_reason: 'tool_calls' }] });
      } else {
        emit({ type: 'message_start', message: { id: 'effect', model: 'fixture', usage: { input_tokens: 17, output_tokens: 0 } } });
        emit({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'append', name: 'AppendFixture', input: {} } });
        emit({ type: 'content_block_stop', index: 0 });
      }
      await completed;
      response.write('data: {"broken": !}\n\n');
      if (protocol === 'openai') emit({ choices: [], usage: { prompt_tokens: 17, completion_tokens: 3 } });
      else {
        emit({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } });
        emit({ type: 'message_stop' });
      }
      response.end();
    }, { permissionMode: 'bypassPermissions', customTools: [{ name: 'AppendFixture', description: 'Append one fixture record.',
      inputSchema: { type: 'object' }, permissionLevel: 'write', async execute() {
        executions++;
        await appendFile(file, 'once\n');
        return { content: 'Saved once.' };
      } }] });
    file = join(f.root, 'effects.txt');
    await f.session.send('Append once.');
    const events = [];
    for await (const event of f.session.stream()) {
      events.push(event);
      if (event.type === 'tool_progress' && event.tool_use_id === 'append' && event.elapsed_time_seconds !== undefined) release();
    }
    assert.equal(executions, 1);
    assert.equal(await readFile(file, 'utf8'), 'once\n');
    assert.equal(f.endpoint.requests.length, protocol === 'anthropic' ? 1 : 2);
    assert.equal(events.findLast(event => event.type === 'result').is_error, protocol === 'anthropic');
    const results = events.flatMap(event => event.type === 'user' && Array.isArray(event.message.content) ? event.message.content : [])
      .filter(block => block.type === 'tool_result' && block.tool_use_id === 'append');
    assert.equal(results.length, 1);
    assert.equal(results[0].content, 'Saved once.');
    assert.notEqual(results[0].is_error, true);
  });
}

for (const model of ['fixture', 'qwen-fixture']) test(`OpenAI refusal text remains literal and is delivered once for ${model}`, deadline, async t => {
  const refusal = 'Fixture request declined: <think>literal text</think>.';
  const f = await sessionFixture(t, 'openai', response => sendSse(response, completionEvents('openai', { refusal })), { model });
  const { result } = await f.send();
  assert.equal(f.endpoint.requests.length, 1);
  assert.equal(result.result, refusal);
});

test('oversized undecoded model data is refused and recovered without growing the request history', deadline, async t => {
  const f = await sessionFixture(t, 'openai', (response, _body, count) => {
    assert.ok(count <= 2);
    if (count === 1) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(Buffer.concat([Buffer.from('data: {"unclosed":"'), Buffer.alloc(32 * 1024 * 1024, 120)]));
    } else sendSse(response, completionEvents('openai', { content: 'Recovered safely.' }));
  });
  const { result } = await f.send();
  assert.equal(result.is_error, false);
  assert.equal(result.result, 'Recovered safely.');
  assert.equal(f.endpoint.requests.length, 2);
  assert.equal(f.endpoint.requests[0].rawBody, f.endpoint.requests[1].rawBody);
});

test('fragmented OpenAI tool names execute the complete name instead of another tool sharing its prefix', deadline, async t => {
  let wrong = 0, intended = 0, file;
  const tool = (name, label) => ({ name, description: 'Record a fixture action.', inputSchema: { type: 'object' }, permissionLevel: 'write',
    async execute() {
      if (label === 'wrong') wrong++; else intended++;
      await appendFile(file, `${label}\n`);
      return { content: label };
    } });
  const f = await sessionFixture(t, 'openai', (response, _body, count) => {
    assert.ok(count <= 2);
    if (count === 1) sendSse(response, [
      { id: 'fragmented', model: 'fixture', choices: [{ delta: { tool_calls: [{ index: 0, id: 'fragmented-call', function: { name: 'Append', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'Preview', arguments: '{}' } }] } }] },
      { choices: [{ finish_reason: 'tool_calls' }], usage: { prompt_tokens: 17, completion_tokens: 3 } },
    ]);
    else sendSse(response, completionEvents('openai', { content: 'The complete tool name was used.' }));
  }, { permissionMode: 'bypassPermissions', includePartialMessages: true,
    customTools: [tool('Append', 'wrong'), tool('AppendPreview', 'intended')] });
  file = join(f.root, 'effects.txt');
  const { result, events } = await f.send();
  assert.equal(result.is_error, false);
  assert.equal(wrong, 0);
  assert.equal(intended, 1);
  assert.equal(await readFile(file, 'utf8'), 'intended\n');
  const calls = events.flatMap(event => event.type === 'assistant' ? event.message.content : []).filter(block => block.type === 'tool_use');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'AppendPreview');
  assert.ok(events.every(event => event.type !== 'stream_event' || event.event.type !== 'tool_name_delta'));
  assert.equal(f.endpoint.requests[1].body.messages.find(message => message.tool_calls)?.tool_calls[0].function.name, 'AppendPreview');
});

for (const kind of ['late-id', 'structured-arguments']) test(`OpenAI ${kind} retain every business argument before execution`, deadline, async t => {
  const payload = { value: 'quoted "\\ 中文🙂\n', mode: 'fixture' };
  let executed = 0, file;
  const f = await sessionFixture(t, 'openai', (response, _body, count) => {
    assert.ok(count <= 2);
    if (count === 1) {
      const first = { index: 0, ...(kind === 'late-id' ? {} : { id: 'record' }),
        function: { name: 'RecordFixture', arguments: kind === 'late-id' ? JSON.stringify(payload) : payload } };
      const events = [{ id: 'fixture', model: 'fixture', choices: [{ delta: { tool_calls: [first] } }] }];
      if (kind === 'late-id') events.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'record' }] } }] });
      events.push({ choices: [{ finish_reason: 'tool_calls' }], usage: { prompt_tokens: 17, completion_tokens: 3 } });
      sendSse(response, events);
    } else sendSse(response, completionEvents('openai', { content: 'Recorded the exact arguments.' }));
  }, { permissionMode: 'bypassPermissions', customTools: [{ name: 'RecordFixture', description: 'Record fixture arguments.',
    inputSchema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } } }, permissionLevel: 'write',
    async execute(input) { executed++; assert.deepEqual(input, payload); await appendFile(file, `${JSON.stringify(input)}\n`); return { content: 'Recorded.' }; } }] });
  file = join(f.root, 'effects.txt');
  const { result } = await f.send();
  assert.equal(result.is_error, false);
  assert.equal(executed, 1);
  assert.deepEqual(JSON.parse((await readFile(file, 'utf8')).trim()), payload);
  assert.equal(f.endpoint.requests.length, 2);
});

test('OpenAI metadata changing after argument announcement retries without executing the prefix tool', deadline, async t => {
  let wrong = 0, intended = 0;
  const f = await sessionFixture(t, 'openai', (response, body, count) => {
    assert.ok(count <= 3);
    const hasResult = body.messages.some(message => message.role === 'tool');
    if (hasResult) { sendSse(response, completionEvents('openai', { content: 'Used the complete tool name.' })); return; }
    const events = [{ id: 'fixture', model: 'fixture', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call',
      function: { name: count === 1 ? 'Append' : 'AppendPreview', arguments: '{}' } }] } }] }];
    if (count === 1) events.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'Preview' } }] } }] });
    events.push({ choices: [{ finish_reason: 'tool_calls' }], usage: { prompt_tokens: 17, completion_tokens: 3 } });
    sendSse(response, events);
  }, { permissionMode: 'bypassPermissions', customTools: [
    { name: 'Append', description: 'Wrong prefix fixture.', inputSchema: { type: 'object' }, permissionLevel: 'write',
      async execute() { wrong++; return { content: 'Wrong action.' }; } },
    { name: 'AppendPreview', description: 'Intended fixture.', inputSchema: { type: 'object' }, permissionLevel: 'write',
      async execute() { intended++; return { content: 'Intended action.' }; } },
  ] });
  const { result } = await f.send();
  assert.equal(result.is_error, false);
  assert.equal(wrong, 0);
  assert.equal(intended, 1);
  assert.equal(f.endpoint.requests.length, 3);
  assert.equal(f.endpoint.requests[0].rawBody, f.endpoint.requests[1].rawBody);
});
