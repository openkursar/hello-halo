import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createModelServer as fixture, sendSse as sse, completionEvents } from './fixtures/model-server.mjs';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const { AnthropicProvider, OpenAiCompatProvider, createSession } = await import(pathToFileURL(join(compiled, 'index.js')).href);

for (const protocol of ['anthropic', 'openai']) {
  for (const kind of ['empty', 'whitespace', 'thinking']) {
    test(`${protocol} session recovers a completed ${kind} response without changing the request`, { timeout: 10_000 }, async t => {
      const root = await mkdtemp(join(tmpdir(), 'halo-empty-response-'));
      let session;
      const first = protocol === 'openai'
        ? kind === 'thinking' ? { reasoning_content: 'Considering the fixture.' } : { content: kind === 'empty' ? '' : ' \t\n\u00a0' }
        : kind === 'thinking' ? [{ type: 'thinking', thinking: 'Considering the fixture.' }]
          : kind === 'empty' ? [] : [{ type: 'text', text: ' \t\n\u00a0' }];
      const answer = protocol === 'openai' ? { content: 'Recovered answer.' } : [{ type: 'text', text: 'Recovered answer.' }];
      const endpoint = await fixture((_request, response) => {
        assert.ok(endpoint.requests.length <= 2, 'empty response recovery must be bounded');
        sse(response, endpoint.requests.length === 1 ? completionEvents(protocol, first) : completionEvents(protocol, answer, 19, 5));
      });
      t.signal.addEventListener('abort', () => session?.close(), { once: true });
      try {
        const provider = protocol === 'anthropic'
          ? new AnthropicProvider({ apiKey: 'fixture-only', baseUrl: endpoint.url })
          : new OpenAiCompatProvider({ id: 'fixture', name: 'Fixture', baseUrl: `${endpoint.url}/v1` });
        session = await createSession({ model: 'fixture', provider, cwd: root,
          env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'state') },
          tools: [], skillCatalog: [], settingSources: [], collaboration: false, persistSession: false,
          systemPrompt: 'Fixture instructions.', thinking: { type: 'disabled' }, maxTurns: 2,
          turnEndChecks: { completion: false, openWork: false } });
        await session.send('Return the fixture answer.');
        const events = [];
        for await (const event of session.stream()) events.push(event);
        assert.equal(endpoint.requests.length, 2);
        assert.equal(endpoint.requests[0].rawBody, endpoint.requests[1].rawBody);
        const results = events.filter(event => event.type === 'result');
        assert.equal(results.length, 1);
        assert.equal(results[0].is_error, false);
        assert.equal(results[0].result, 'Recovered answer.');
        assert.equal(results[0].num_turns, 2);
        assert.equal(results[0].usage.input_tokens, 36);
        assert.equal(results[0].usage.output_tokens, 8);
        assert.equal(events.at(-1).state, 'idle');
      } finally {
        await session?.[Symbol.asyncDispose]();
        await endpoint.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  test(`${protocol} repeated empty responses stop with accounted usage and a resumable history`, { timeout: 10_000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'halo-empty-exhaustion-'));
    let session, recovered = false;
    const empty = protocol === 'openai' ? { content: ' \n' } : [{ type: 'text', text: ' \n' }];
    const answer = protocol === 'openai' ? { content: 'Server recovered.' } : [{ type: 'text', text: 'Server recovered.' }];
    const endpoint = await fixture((_request, response) => {
      assert.ok(endpoint.requests.length <= (recovered ? 4 : 3), 'recovery must not retry forever');
      sse(response, completionEvents(protocol, recovered ? answer : empty));
    });
    t.signal.addEventListener('abort', () => session?.close(), { once: true });
    const options = { model: 'fixture', cwd: root,
      provider: protocol === 'anthropic' ? new AnthropicProvider({ apiKey: 'fixture-only', baseUrl: endpoint.url })
        : new OpenAiCompatProvider({ id: 'fixture', name: 'Fixture', baseUrl: `${endpoint.url}/v1` }),
      env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'state') },
      tools: [], skillCatalog: [], settingSources: [], collaboration: false,
      systemPrompt: 'Fixture instructions.', thinking: { type: 'disabled' }, maxTurns: 8,
      turnEndChecks: { completion: false, openWork: false } };
    try {
      session = await createSession(options);
      await session.send('Return an answer.');
      const events = [];
      for await (const event of session.stream()) events.push(event);
      assert.equal(endpoint.requests.length, 3);
      assert.ok(endpoint.requests.every(request => request.rawBody === endpoint.requests[0].rawBody));
      const result = events.findLast(event => event.type === 'result');
      assert.equal(result.is_error, true);
      assert.match(result.result, /model.*no answer or tool call/i);
      assert.equal(result.num_turns, 3);
      assert.equal(result.usage.input_tokens, 51);
      assert.equal(result.usage.output_tokens, 9);
      assert.equal(events.at(-1).state, 'idle');
      const id = session.sessionId;
      await session[Symbol.asyncDispose]();
      const journalPath = join(root, 'state', 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
      const records = (await readFile(journalPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(records.filter(record => record.type === 'assistant').length, 0);
      const metadata = records.filter(record => record.type === 'assistant_metadata');
      assert.equal(metadata.length, 3);
      assert.equal(metadata.reduce((total, record) => total + record.message.usage.input_tokens, 0), 51);
      recovered = true;
      session = await createSession({ ...options, resume: id, strictResume: true });
      await session.send('The server is ready. Try again.');
      const resumed = [];
      for await (const event of session.stream()) resumed.push(event);
      assert.equal(endpoint.requests.length, 4);
      assert.equal(resumed.findLast(event => event.type === 'result').result, 'Server recovered.');
      assert.equal(resumed.findLast(event => event.type === 'result').is_error, false);
      assert.equal(endpoint.requests[3].body.messages.some(message => message.role === 'assistant'), false);
    } finally {
      await session?.[Symbol.asyncDispose]();
      await endpoint.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`${protocol} empty-response recovery respects the configured turn limit`, { timeout: 10_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'halo-empty-turn-limit-'));
    const endpoint = await fixture((_request, response) => sse(response, completionEvents(protocol, protocol === 'openai' ? {} : [])));
    let session;
    try {
      session = await createSession({ model: 'fixture', cwd: root,
        provider: protocol === 'anthropic' ? new AnthropicProvider({ apiKey: 'fixture-only', baseUrl: endpoint.url })
          : new OpenAiCompatProvider({ id: 'fixture', name: 'Fixture', baseUrl: `${endpoint.url}/v1` }),
        env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'state') },
        tools: [], skillCatalog: [], settingSources: [], collaboration: false, persistSession: false,
        systemPrompt: 'Fixture instructions.', thinking: { type: 'disabled' }, maxTurns: 1,
        turnEndChecks: { completion: false, openWork: false } });
      await session.send('Return an answer.');
      const events = [];
      for await (const event of session.stream()) events.push(event);
      assert.equal(endpoint.requests.length, 1);
      const result = events.findLast(event => event.type === 'result');
      assert.equal(result.subtype, 'error_max_turns');
      assert.equal(result.num_turns, 1);
      assert.equal(result.usage.input_tokens, 17);
      assert.equal(result.usage.output_tokens, 3);
    } finally {
      await session?.[Symbol.asyncDispose]();
      await endpoint.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`${protocol} empty responses after a completed tool retain the result without replay on retry or resume`, { timeout: 10_000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'halo-empty-after-effect-'));
    const effect = join(root, 'effects.txt');
    const events = [];
    let session, executions = 0;
    const endpoint = await fixture((_request, response, body) => {
      const count = endpoint.requests.length;
      assert.ok(count <= 5);
      if (count === 1) {
        if (protocol === 'openai') sse(response, [
          { id: 'fixture-response', model: 'fixture', choices: [{ delta: { tool_calls: [{ index: 0, id: 'append-once',
            function: { name: 'AppendFixture', arguments: '{}' } }] } }] },
          { choices: [{ finish_reason: 'tool_calls' }], usage: { prompt_tokens: 9, completion_tokens: 2 } },
        ]);
        else {
          const frames = completionEvents(protocol, [{ type: 'tool_use', id: 'append-once', name: 'AppendFixture', input: {} }], 9, 2);
          frames.at(-2).delta.stop_reason = 'tool_use';
          sse(response, frames);
        }
        return;
      }
      assert.equal(executions, 1);
      assert.ok(JSON.stringify(body.messages).includes('Appended exactly once.'));
      if (count <= 4) assert.equal(events.filter(event => event.type === 'user' && Array.isArray(event.message.content)
        && event.message.content.some(block => block.type === 'tool_result' && block.tool_use_id === 'append-once')).length, 1);
      const answer = protocol === 'openai' ? { content: 'Saved once.' } : [{ type: 'text', text: 'Saved once.' }];
      sse(response, count < 4 ? completionEvents(protocol, protocol === 'openai' ? {} : []) : completionEvents(protocol, answer, 19, 5));
    });
    t.signal.addEventListener('abort', () => session?.close(), { once: true });
    const options = { model: 'fixture', cwd: root,
      provider: protocol === 'anthropic' ? new AnthropicProvider({ apiKey: 'fixture-only', baseUrl: endpoint.url })
        : new OpenAiCompatProvider({ id: 'fixture', name: 'Fixture', baseUrl: `${endpoint.url}/v1` }),
      env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'state') },
      tools: [], skillCatalog: [], settingSources: [], collaboration: false,
      customTools: [{ name: 'AppendFixture', description: 'Append a fixture record.', inputSchema: { type: 'object' },
        permissionLevel: 'write', async execute() {
          executions++;
          await appendFile(effect, 'once\n');
          return { content: 'Appended exactly once.' };
        } }],
      permissionMode: 'bypassPermissions', systemPrompt: 'Fixture instructions.', thinking: { type: 'disabled' }, maxTurns: 6,
      turnEndChecks: { completion: false, openWork: false } };
    try {
      session = await createSession(options);
      await session.send('Append the fixture record once.');
      for await (const event of session.stream()) events.push(event);
      assert.equal(endpoint.requests.length, 4);
      assert.equal(endpoint.requests[1].rawBody, endpoint.requests[2].rawBody);
      assert.equal(endpoint.requests[2].rawBody, endpoint.requests[3].rawBody);
      const result = events.findLast(event => event.type === 'result');
      assert.equal(result.is_error, false);
      assert.equal(result.result, 'Saved once.');
      assert.equal(result.num_turns, 4);
      assert.equal(result.usage.input_tokens, 62);
      assert.equal(result.usage.output_tokens, 13);
      assert.equal(await readFile(effect, 'utf8'), 'once\n');
      const id = session.sessionId;
      await session[Symbol.asyncDispose]();
      const journalPath = join(root, 'state', 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
      const records = (await readFile(journalPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(records.filter(record => record.type === 'assistant').length, 2);
      assert.equal(records.filter(record => record.message?.content?.some?.(block => block.type === 'tool_result')).length, 1);
      session = await createSession({ ...options, resume: id, strictResume: true });
      await session.send('Review the recorded result.');
      const resumed = [];
      for await (const event of session.stream()) resumed.push(event);
      assert.equal(resumed.findLast(event => event.type === 'result').is_error, false);
      assert.equal(executions, 1);
      assert.equal(await readFile(effect, 'utf8'), 'once\n');
      assert.equal(endpoint.requests.length, 5);
    } finally {
      await session?.[Symbol.asyncDispose]();
      await endpoint.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`${protocol} truncated tool arguments retry before execution and preserve reported usage`, { timeout: 10_000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'halo-truncated-tool-'));
    const effect = join(root, 'effects.txt');
    let session, executions = 0;
    const endpoint = await fixture((_request, response) => {
      const count = endpoint.requests.length;
      assert.ok(count <= 3);
      if (count <= 2) assert.equal(executions, 0);
      if (protocol === 'openai' && count <= 2) {
        const chunks = [
          { id: 'fixture-response', model: 'fixture', choices: [], usage: { prompt_tokens: 11, completion_tokens: 0 } },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'append-once',
            function: { name: 'AppendFixture', arguments: count === 1 ? '{"line":' : '{"line":"once"}' } }] } }] },
        ];
        if (count === 2) chunks.push({ choices: [{ finish_reason: 'tool_calls' }], usage: { prompt_tokens: 13, completion_tokens: 4 } });
        sse(response, chunks);
      } else if (count === 1) sse(response, [
        { type: 'message_start', message: { id: 'fixture-response', model: 'fixture', usage: { input_tokens: 11, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'append-once', name: 'AppendFixture', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"line":' } },
      ]);
      else if (count === 2) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 'fixture-response', model: 'fixture',
          content: [{ type: 'tool_use', id: 'append-once', name: 'AppendFixture', input: { line: 'once' } }],
          stop_reason: 'tool_use', usage: { input_tokens: 13, output_tokens: 4 } }));
      } else sse(response, completionEvents(protocol, protocol === 'openai' ? { content: 'Done once.' } : [{ type: 'text', text: 'Done once.' }]));
    });
    t.signal.addEventListener('abort', () => session?.close(), { once: true });
    try {
      session = await createSession({ model: 'fixture', cwd: root,
        provider: protocol === 'anthropic' ? new AnthropicProvider({ apiKey: 'fixture-only', baseUrl: endpoint.url })
          : new OpenAiCompatProvider({ id: 'fixture', name: 'Fixture', baseUrl: `${endpoint.url}/v1` }),
        env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'state') },
        tools: [], skillCatalog: [], settingSources: [], collaboration: false, persistSession: false,
        customTools: [{ name: 'AppendFixture', description: 'Append a fixture record.', permissionLevel: 'write',
          inputSchema: { type: 'object', required: ['line'], properties: { line: { type: 'string' } } },
          async execute(input) { executions++; await appendFile(effect, `${input.line}\n`); return { content: 'Appended.' }; } }],
        permissionMode: 'bypassPermissions', systemPrompt: 'Fixture instructions.', thinking: { type: 'disabled' },
        turnEndChecks: { completion: false, openWork: false } });
      await session.send('Append once.');
      const events = [];
      for await (const event of session.stream()) events.push(event);
      assert.equal(executions, 1);
      assert.equal(await readFile(effect, 'utf8'), 'once\n');
      assert.equal(endpoint.requests.length, 3);
      assert.deepEqual(endpoint.requests[0].body.messages, endpoint.requests[1].body.messages);
      assert.deepEqual(endpoint.requests[0].body.tools, endpoint.requests[1].body.tools);
      assert.equal(endpoint.requests[0].body.stream, true);
      assert.equal(endpoint.requests[1].body.stream, protocol === 'openai');
      assert.equal(events.filter(event => event.subtype === 'api_retry').length, 1);
      const result = events.findLast(event => event.type === 'result');
      assert.equal(result.is_error, false);
      assert.equal(result.result, 'Done once.');
      assert.equal(result.usage.input_tokens, 41);
      assert.equal(result.usage.output_tokens, 7);
    } finally {
      await session?.[Symbol.asyncDispose]();
      await endpoint.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

const request = { model: 'fixture', messages: [{ role: 'user', content: 'hello' }], maxTokens: 50, stream: true };

for (const kind of ['empty', 'truncated']) {
  test(`reported ${kind} response usage stops recovery at the execution budget`, { timeout: 10_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'halo-response-budget-'));
    const endpoint = await fixture((_request, response) => sse(response, kind === 'empty'
      ? completionEvents('openai', {})
      : [{ id: 'fixture-response', model: 'fixture', choices: [], usage: { prompt_tokens: 17, completion_tokens: 0 } }]));
    let session;
    try {
      session = await createSession({ model: 'fixture', cwd: root,
        provider: new OpenAiCompatProvider({ id: 'fixture', name: 'Fixture', baseUrl: `${endpoint.url}/v1`, apiKey: 'fixture-only' }),
        env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'state') },
        tools: [], skillCatalog: [], settingSources: [], collaboration: false, persistSession: false,
        systemPrompt: 'Fixture instructions.', thinking: { type: 'disabled' }, maxBudgetUsd: 0.00001,
        modelPricing: { fixture: { inputPerMtk: 1, outputPerMtk: 1, cacheReadPerMtk: 0, cacheCreationPerMtk: 0 } },
        turnEndChecks: { completion: false, openWork: false } });
      await session.send('Return an answer.');
      const events = [];
      for await (const event of session.stream()) events.push(event);
      assert.equal(endpoint.requests.length, 1);
      const result = events.findLast(event => event.type === 'result');
      assert.equal(result.subtype, 'error_max_budget_usd');
      assert.equal(result.num_turns, 1);
      assert.equal(result.usage.input_tokens, 17);
      assert.equal(result.usage.output_tokens, kind === 'empty' ? 3 : 0);
      assert.ok(result.total_cost_usd >= 0.000017);
      assert.equal(events.at(-1).state, 'idle');
    } finally {
      await session?.[Symbol.asyncDispose]();
      await endpoint.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('empty-response recovery can be interrupted while the server waits and the same session remains usable', { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'halo-empty-cancellation-'));
  let ready, session;
  const waiting = new Promise(resolve => { ready = resolve; });
  const endpoint = await fixture((_request, response) => {
    const count = endpoint.requests.length;
    assert.ok(count <= 3);
    if (count === 2) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      ready();
    } else sse(response, completionEvents('openai', count === 1 ? {} : { content: 'New turn works.' }));
  });
  t.signal.addEventListener('abort', () => { ready(); session?.close(); }, { once: true });
  try {
    session = await createSession({ model: 'fixture', cwd: root,
      provider: new OpenAiCompatProvider({ id: 'fixture', name: 'Fixture', baseUrl: `${endpoint.url}/v1`, apiKey: 'fixture-only' }),
      env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'state') },
      tools: [], skillCatalog: [], settingSources: [], collaboration: false, persistSession: false,
      systemPrompt: 'Fixture instructions.', thinking: { type: 'disabled' },
      turnEndChecks: { completion: false, openWork: false } });
    await session.send('Return an answer.');
    const events = [];
    const draining = (async () => { for await (const event of session.stream()) events.push(event); })();
    await waiting;
    t.signal.throwIfAborted();
    assert.equal(endpoint.requests.length, 2);
    await session.interrupt();
    await draining;
    assert.equal(events.findLast(event => event.type === 'result').is_error, true);
    assert.match(events.findLast(event => event.type === 'result').result, /abort|interrupt/i);
    assert.equal(events.findLast(event => event.type === 'result').usage.input_tokens, 17);
    assert.equal(events.at(-1).state, 'idle');
    await session.send('Start the next turn.');
    const next = [];
    for await (const event of session.stream()) next.push(event);
    assert.equal(endpoint.requests.length, 3);
    assert.equal(next.findLast(event => event.type === 'result').is_error, false);
    assert.equal(next.findLast(event => event.type === 'result').result, 'New turn works.');
  } finally {
    await session?.[Symbol.asyncDispose]();
    await endpoint.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const protocol of ['anthropic', 'openai']) {
  test(`${protocol} retries a transient HTTP failure without changing the request`, { timeout: 10_000 }, async context => {
    const status = protocol === 'anthropic' ? 429 : 503;
    const endpoint = await fixture((_request, response) => {
      if (endpoint.requests.length === 1) {
        response.writeHead(status, { 'content-type': 'application/json', 'retry-after': '1' });
        response.end(JSON.stringify({ error: { message: 'Temporarily unavailable.' } }));
      } else if (protocol === 'anthropic') {
        sse(response, [
          { type: 'message_start', message: { id: 'recovered', model: 'fixture', usage: { input_tokens: 10, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Recovered.' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
          { type: 'message_stop' },
        ]);
      } else {
        sse(response, [
          { id: 'recovered', model: 'fixture', choices: [{ delta: { content: 'Recovered.' } }] },
          { choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
        ]);
      }
    });
    try {
      const provider = protocol === 'anthropic'
        ? new AnthropicProvider({ apiKey: 'fixture-only', baseUrl: endpoint.url })
        : new OpenAiCompatProvider({ id: 'fixture', name: 'Fixture', baseUrl: `${endpoint.url}/v1` });
      const events = [];
      for await (const event of provider.createMessageStream({ ...request, providerOptions: { signal: context.signal } })) events.push(event);
      assert.equal(endpoint.requests.length, 2);
      assert.equal(endpoint.requests[0].rawBody, endpoint.requests[1].rawBody);
      assert.equal(endpoint.requests[0].path, endpoint.requests[1].path);
      const retries = events.filter(event => event.type === 'retry');
      assert.equal(retries.length, 1);
      assert.equal(retries[0].attempt, 1);
      assert.equal(retries[0].status, status);
      assert.equal(retries[0].delayMs, 1000);
      assert.equal(events.filter(event => event.type === 'text_delta').map(event => event.text).join(''), 'Recovered.');
      assert.equal(events.at(-1).type, 'message_stop');
    } finally { await endpoint.close(); }
  });
}

test('a completed file effect is retained without replay after the HTTP stream disconnects', { timeout: 10_000 }, async context => {
  const root = await mkdtemp(join(tmpdir(), 'halo-streamed-effect-'));
  const file = join(root, 'effects.txt');
  let completed;
  const completion = new Promise(resolve => { completed = resolve; });
  let session;
  context.signal.addEventListener('abort', () => { completed(); session?.close(); }, { once: true });
  const endpoint = await fixture(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = value => response.write(`data: ${JSON.stringify(value)}\n\n`);
    emit({ type: 'message_start', message: { id: 'write', model: 'fixture', usage: { input_tokens: 10, output_tokens: 0 } } });
    emit({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'save-once', name: 'SaveFixture', input: {} } });
    emit({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } });
    emit({ type: 'content_block_stop', index: 0 });
    await completion;
    response.end();
  });
  try {
    session = await createSession({ model: 'fixture',
      provider: new AnthropicProvider({ apiKey: 'fixture-only', baseUrl: endpoint.url }),
      cwd: root, env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'state') },
      tools: [], skillCatalog: [], settingSources: [], collaboration: false, persistSession: false,
      systemPrompt: 'Fixture.', permissionMode: 'bypassPermissions', thinking: { type: 'disabled' },
      turnEndChecks: { completion: false, openWork: false },
      customTools: [{ name: 'SaveFixture', description: 'Append one fixture record.', permissionLevel: 'write',
        inputSchema: { type: 'object' }, async execute() {
          await appendFile(file, 'saved\n');
          return { content: 'Saved exactly once.', isError: false };
        } }],
    });
    await session.send('Save the fixture record.');
    const events = [];
    for await (const event of session.stream()) {
      events.push(event);
      if (event.type === 'tool_progress' && event.tool_use_id === 'save-once' && event.elapsed_time_seconds !== undefined) completed();
    }
    assert.equal(endpoint.requests.length, 1);
    assert.equal(await readFile(file, 'utf8'), 'saved\n');
    const results = events.flatMap(event => event.type === 'user' && Array.isArray(event.message.content) ? event.message.content : [])
      .filter(block => block.type === 'tool_result');
    assert.equal(results.length, 1);
    assert.equal(results[0].content, 'Saved exactly once.');
    assert.notEqual(results[0].is_error, true);
    const terminal = events.filter(event => event.type === 'result');
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].is_error, true);
  } finally {
    completed();
    await session?.[Symbol.asyncDispose]();
    await endpoint.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('summary requests preserve the actual Anthropic wire prefix and cache boundaries', async () => {
  const { fullCompact, estimateMessageTokens } = await import(pathToFileURL(join(compiled, 'index.js')).href);
  const endpoint = await fixture((_request, response) => sse(response, [
    { type: 'message_start', message: { id: 'summary', model: 'fixture', usage: { input_tokens: 21, output_tokens: 0, cache_read_input_tokens: 300 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The user requested a report. Evidence is in the transcript.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 17 } },
    { type: 'message_stop' },
  ]));
  try {
    const provider = new AnthropicProvider({ apiKey: 'fixture-not-a-key', baseUrl: endpoint.url });
    const source = Array.from({ length: 24 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user',
      content: `Record ${index}: ${'verified evidence '.repeat(300)}` }));
    const request = { model: 'fixture', messages: source, stream: true, maxTokens: 6000,
      systemPrompt: [{ type: 'text', text: 'Stable system', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Stable project context' }],
      tools: [{ name: 'work', description: 'Read', input_schema: { type: 'object' } }],
      thinking: { type: 'enabled', budgetTokens: 1024 }, providerOptions: { effort: 'high' } };
    await provider.createMessage(request);
    const compacted = await fullCompact(source, provider, 'fixture', '', [], undefined, undefined, {
      request, maxTokens: 4000, targetInputTokens: 20_000, estimateInputTokens: estimateMessageTokens,
    });
    assert.equal(endpoint.requests.length, 2);
    const [normal, summary] = endpoint.requests.map(request => request.body);
    assert.deepEqual(normal.system[0].cache_control, { type: 'ephemeral' });
    assert.deepEqual(summary.system, normal.system);
    assert.deepEqual(summary.tools, normal.tools);
    assert.deepEqual(summary.thinking, normal.thinking);
    assert.deepEqual(summary.messages.slice(0, -1), normal.messages);
    assert.ok((JSON.stringify(summary).match(/cache_control/g) ?? []).length <= 4);
    assert.ok(compacted.tokensFreed > 0);
    assert.match(compacted.summary, /Evidence is in the transcript/);
  } finally { await endpoint.close(); }
});

test('opening-text identity projection preserves request bytes while avoiding full-history callbacks', async t => {
  const endpoint = await fixture((_request, response) => sse(response, [
    { type: 'message_start', message: { id: 'fixture', model: 'fixture', usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
    { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]));
  const messages = [{ role: 'user', content: 'Opening fixture text.\n' },
    ...Array.from({ length: 256 }, (_, index) => ({ role: index % 2 ? 'user' : 'assistant', content: `${index} ${'recorded fixture evidence '.repeat(200)}` }))];
  const sizes = [], durations = [];
  try {
    for (const projected of [false, true]) {
      const provider = new AnthropicProvider({ apiKey: 'fixture-only', baseUrl: endpoint.url, requestIdentity: {
        ...(projected ? { systemPrefixMessages: 'first-user-text' } : {}),
        systemPrefix: history => { sizes.push(Buffer.byteLength(JSON.stringify(history))); return { type: 'text', text: String(history.find(message => message.role === 'user')?.content ?? '') }; },
      } });
      const start = process.hrtime.bigint();
      await provider.createMessage({ ...request, messages, systemPrompt: 'Fixture system.' });
      durations.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    const digest = text => createHash('sha256').update(text).digest('hex');
    assert.equal(digest(endpoint.requests[0].rawBody), digest(endpoint.requests[1].rawBody));
    assert.ok(sizes[0] > 1_000_000); assert.ok(sizes[1] < 100);
    t.diagnostic(JSON.stringify({ callbackBytes: sizes, elapsedMs: durations, requestBytes: Buffer.byteLength(endpoint.requests[0].rawBody) }));
  } finally { await endpoint.close(); }
});

test('builtin provider overrides remain callable and Anthropic completion respects an overridden stream', async () => {
  const provider = new AnthropicProvider({ apiKey: 'fixture-only', baseUrl: 'http://127.0.0.1:1', defaultModel: 'fixture' });
  let calls = 0;
  provider.createMessageStream = async function* (request) {
    calls++; assert.equal(request.stream, true);
    yield { type: 'message_start', id: 'override', model: request.model, usage: { input_tokens: 2, output_tokens: 0 } };
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
    yield { type: 'text_delta', index: 0, text: 'Override response.' }; yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_delta', stopReason: 'end_turn', usage: { output_tokens: 1 } }; yield { type: 'message_stop' };
  };
  const completed = await provider.createMessage({ ...request, stream: false });
  assert.equal(completed.content[0].text, 'Override response.'); assert.equal(calls, 1);
  const root = await mkdtemp(join(tmpdir(), 'halo-provider-override-'));
  let session;
  try {
    session = await createSession({ model: 'fixture', provider, cwd: root, env: { HOME: root }, tools: [], collaboration: false,
      persistSession: false, systemPrompt: 'Fixture.', thinking: { type: 'disabled' } });
    await session.send('Use the override.'); let result;
    for await (const event of session.stream()) if (event.type === 'result') result = event;
    assert.equal(result.result, 'Override response.'); assert.equal(calls, 2);
  } finally { await session?.[Symbol.asyncDispose](); await rm(root, { recursive: true, force: true }); }
});

test('standalone native Anthropic provider preserves request callbacks and complete-response assembly', async () => {
  const attempts = [];
  const endpoint = await fixture((_request, response) => sse(response, [
    { type: 'message_start', message: { id: 'one', model: 'reported', usage: { input_tokens: 12, output_tokens: 0 } } },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: 'ignored at start' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'answer' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reason' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'first' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'second' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ]));
  try {
    const provider = new AnthropicProvider({ apiKey: 'fixture-only', baseUrl: endpoint.url,
      requestIdentity: {
        headersForAttempt: async (attempt, { signal }) => { assert.equal(signal.aborted, false); attempts.push(attempt); return { 'x-fixture-attempt': String(attempt) }; },
        systemPrefix: async (messages, { signal }) => { assert.equal(signal.aborted, false); assert.deepEqual(messages, request.messages); return { type: 'text', text: 'Prefix exactly.\n' }; },
      } });
    const result = await provider.createMessage({ ...request, systemPrompt: 'System' });
    assert.deepEqual(result, { id: 'one', model: 'reported', stopReason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 4 }, content: [
        { type: 'thinking', thinking: 'reason', signature: 'second' }, { type: 'text', text: 'answer' },
      ] });
    assert.deepEqual(attempts, [0]);
    assert.equal(endpoint.requests[0].path, '/v1/messages');
    assert.equal(endpoint.requests[0].headers['x-fixture-attempt'], '0');
    assert.equal(endpoint.requests[0].body.stream, true);
    assert.equal(endpoint.requests[0].body.system[0].text, 'Prefix exactly.\n');
  } finally { await endpoint.close(); }
});

test('standalone native OpenAI provider uses nonstreaming complete and independent streaming requests', async () => {
  const endpoint = await fixture((_request, response, body) => {
    if (!body.stream) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'complete', model: 'reported', choices: [{ message: { content: 'complete answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } } }));
    } else sse(response, [
      { id: 'stream', model: 'reported', choices: [{ delta: { content: 'stream answer' } }] },
      { choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
    ]);
  });
  try {
    const provider = new OpenAiCompatProvider({ id: 'fixture-openai', name: 'Fixture OpenAI', baseUrl: `${endpoint.url}/v1` });
    const result = await provider.createMessage(request);
    assert.equal(result.content[0].text, 'complete answer');
    assert.deepEqual(result.usage, { input_tokens: 6, output_tokens: 3, cache_read_input_tokens: 4 });
    const events = [];
    for await (const event of provider.createMessageStream(request)) events.push(event);
    assert.equal(events.at(-1).type, 'message_stop');
    assert.ok(events.some(event => event.type === 'text_delta' && event.text === 'stream answer'));
    assert.deepEqual(endpoint.requests.map(request => [request.path, request.body.stream]), [['/v1/chat/completions', false], ['/v1/chat/completions', true]]);
  } finally { await endpoint.close(); }
});


test('native session uses the builtin OpenAI provider for a real file tool exchange', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'native-openai-session-'));
  const file = join(workspace, 'result.txt');
  let count = 0;
  let observedToolResult = false;
  let session;
  const endpoint = await fixture(async (_request, response, body) => {
    count++;
    if (count === 1) sse(response, [
      { id: 'first', model: 'fixture', choices: [{ delta: { tool_calls: [{ index: 0, id: 'file-call', function: { name: 'Write', arguments: JSON.stringify({ file_path: file, content: 'native-openai-file' }) } }] } }] },
      { choices: [{ finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 4 } },
    ]);
    else {
      observedToolResult = body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'file-call');
      sse(response, [
        { id: 'second', model: 'fixture', choices: [{ delta: { content: 'done' } }] },
        { choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 25, completion_tokens: 2 } },
      ]);
    }
  });
  try {
    const provider = new OpenAiCompatProvider({ id: 'fixture-openai', name: 'Fixture OpenAI', baseUrl: `${endpoint.url}/v1` });
    session = await createSession({ model: 'fixture', provider, cwd: workspace, persistSession: false,
      tools: ['Write'], permissionMode: 'bypassPermissions', systemPrompt: 'Local fixture',
      collaboration: false, thinking: { type: 'disabled' }, env: { HOME: workspace } });
    await session.send('Write the fixture file.');
    const events = [];
    for await (const event of session.stream()) events.push(event);
    assert.equal(events.filter(event => event.type === 'result').at(-1).subtype, 'success');
    assert.equal(events.at(-1).subtype, 'session_state_changed');
    assert.equal(events.at(-1).state, 'idle');
    assert.equal(count, 2);
    assert.equal(await readFile(file, 'utf8'), 'native-openai-file');
    assert.equal(observedToolResult, true);
    assert.ok(endpoint.requests[0].body.tools.some(tool => tool.function.name === 'Write'));
  } finally { await session?.[Symbol.asyncDispose](); await endpoint.close(); await rm(workspace, { recursive: true, force: true }); }
});
