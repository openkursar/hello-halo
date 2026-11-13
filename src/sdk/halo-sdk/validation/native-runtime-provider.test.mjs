import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const entry = pathToFileURL(join(compiled, 'native/index.js')).href;
const { createNativeRuntime } = await import(entry);

async function endpoint() {
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ path: request.url, key: request.headers.authorization ?? request.headers['x-api-key'], model: body.model });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = value => response.write(`data: ${JSON.stringify(value)}\n\n`);
    if (request.url.endsWith('/messages')) {
      for (const event of [
        { type: 'message_start', message: { id: 'fixture', model: body.model, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Fixture reply.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]) emit(event);
    } else {
      emit({ id: 'fixture', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'Fixture reply.' } }] });
      emit({ id: 'fixture', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      response.write('data: [DONE]\n\n');
    }
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, url: `http://127.0.0.1:${server.address().port}`,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'halo-runtime-provider-'));
  const ambient = await endpoint(), selected = await endpoint();
  const environment = new Map(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'].map(name => [name, process.env[name]]));
  process.env.ANTHROPIC_API_KEY = 'synthetic-ambient-key';
  process.env.ANTHROPIC_BASE_URL = ambient.url;
  const runtime = createNativeRuntime();
  const options = { model: 'configured-model', cwd: root, env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'state') },
    tools: [], skillCatalog: [], settingSources: [], collaboration: false, persistSession: false,
    systemPrompt: 'Fixture.', thinking: { type: 'disabled' }, maxTurns: 1 };
  try { await run({ runtime, options, root, ambient, selected }); }
  finally {
    await runtime.close();
    for (const [name, value] of environment) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await Promise.all([ambient.close(), selected.close()]);
    await rm(root, { recursive: true, force: true });
  }
}

async function consume(events) {
  let result;
  for await (const event of events) if (event.type === 'result') result = event;
  assert.equal(result?.is_error, false);
  assert.equal(result?.result, 'Fixture reply.');
}

test('native runtime sessions and queries honor explicit provider configuration over ambient credentials', { timeout: 10_000 }, async () => {
  await fixture(async ({ runtime, options, ambient, selected }) => {
    for (const type of ['openai-compat', 'anthropic']) {
      const providerConfig = { type, apiKey: `synthetic-${type}-key`, baseUrl: type === 'anthropic' ? selected.url : `${selected.url}/v1` };
      const configured = { ...options, apiKey: 'synthetic-legacy-key', anthropicBaseUrl: ambient.url, providerConfig };
      const session = await runtime.createSession(configured);
      try { await session.send('Reply.'); await consume(session.stream()); }
      finally { await session[Symbol.asyncDispose](); }
      await consume(runtime.query({ prompt: 'Reply.', options: configured }));
    }
    assert.equal(ambient.requests.length, 0);
    assert.deepEqual(selected.requests, ['openai-compat', 'anthropic'].flatMap(type => Array.from({ length: 2 }, () => ({
      path: type === 'anthropic' ? '/v1/messages' : '/v1/chat/completions',
      key: type === 'anthropic' ? `synthetic-${type}-key` : `Bearer synthetic-${type}-key`, model: 'configured-model',
    }))));
  });
});

test('native setup receives the configured provider before applying its own override', { timeout: 10_000 }, async () => {
  await fixture(async ({ runtime, options, root, ambient, selected }) => {
    const setup = join(root, 'setup.mjs');
    await writeFile(setup, `export async function setup(options, data) {
      if (Object.hasOwn(options, 'providerConfig') || options.provider?.id !== 'configured-fixture') throw new Error('Provider configuration was not prepared before setup');
      const { createProvider } = await import(data.entry);
      return { ...options, provider: createProvider(data.providerConfig) };
    }`);
    const session = await runtime.createSession({ ...options,
      providerConfig: { type: 'openai-compat', providerId: 'configured-fixture', apiKey: 'synthetic-initial-key', baseUrl: `${selected.url}/v1` },
    }, { setup: { module: pathToFileURL(setup).href, data: { entry,
      providerConfig: { type: 'anthropic', apiKey: 'synthetic-setup-key', baseUrl: selected.url },
    } } });
    try { await session.send('Reply.'); await consume(session.stream()); }
    finally { await session[Symbol.asyncDispose](); }
    assert.equal(ambient.requests.length, 0);
    assert.deepEqual(selected.requests, [{ path: '/v1/messages', key: 'synthetic-setup-key', model: 'configured-model' }]);
  });
});

test('native runtime rejects incomplete explicit configuration without falling back to environment', { timeout: 10_000 }, async () => {
  await fixture(async ({ runtime, options, ambient, selected }) => {
    await assert.rejects(runtime.createSession({ ...options,
      providerConfig: { type: 'openai-compat', baseUrl: `${selected.url}/v1` },
    }), /providerConfig.*apiKey/);
    assert.equal(ambient.requests.length, 0);
    assert.equal(selected.requests.length, 0);
  });
});

test('native runtime refuses missing provider credentials and keeps the explicit legacy path', { timeout: 10_000 }, async () => {
  await fixture(async ({ runtime, options, ambient, selected }) => {
    process.env.ANTHROPIC_API_KEY = '';
    await assert.rejects(runtime.createSession(options), /requires options\.provider/);
    assert.equal(ambient.requests.length, 0);
    assert.equal(selected.requests.length, 0);
    const session = await runtime.createSession({ ...options, apiKey: 'synthetic-legacy-key', anthropicBaseUrl: selected.url });
    try { await session.send('Reply.'); await consume(session.stream()); }
    finally { await session[Symbol.asyncDispose](); }
    assert.deepEqual(selected.requests, [{ path: '/v1/messages', key: 'synthetic-legacy-key', model: 'configured-model' }]);
    assert.equal(ambient.requests.length, 0);
  });
});
