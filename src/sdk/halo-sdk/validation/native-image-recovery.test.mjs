import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, appendFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const { createSession, AnthropicProvider, OpenAiCompatProvider, ProviderError } = await import(pathToFileURL(join(compiled, 'index.js')).href);
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBYkAAAAASUVORK5CYII=';

function images(body) {
  const result = [];
  function visit(blocks) {
    for (const block of blocks) {
      if (block.type === 'image') result.push(block.source?.data);
      else if (block.type === 'image_url') result.push(block.image_url?.url?.split(',')[1]);
      else if (block.type === 'tool_result' && Array.isArray(block.content)) visit(block.content);
    }
  }
  for (const message of body.messages) if (Array.isArray(message.content)) visit(message.content);
  return result;
}

async function fixture(context, protocol, respond) {
  const root = await mkdtemp(join(tmpdir(), 'halo-image-recovery-'));
  const requests = [];
  const controller = new AbortController();
  context.signal.addEventListener('abort', () => controller.abort(), { once: true });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    const reply = respond(body, requests.length, root);
    if (reply.error) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { type: 'invalid_request_error', message: reply.error } }));
      return;
    }
    const events = [];
    if (protocol === 'anthropic') {
      events.push({ type: 'message_start', message: { id: 'fixture', model: body.model, usage: { input_tokens: 10, output_tokens: 0 } } });
      for (const [index, block] of (reply.tools ?? [{ type: 'text', text: reply.text ?? 'Continue.' }]).entries()) {
        events.push({ type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } });
        events.push({ type: 'content_block_delta', index, delta: block.type === 'text'
          ? { type: 'text_delta', text: block.text }
          : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
        events.push({ type: 'content_block_stop', index });
      }
      events.push({ type: 'message_delta', delta: { stop_reason: reply.tools ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' });
    } else {
      events.push(reply.tools
        ? { id: 'fixture', model: body.model, choices: [{ delta: { tool_calls: reply.tools.map((block, index) => ({ index, id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } })) } }] }
        : { id: 'fixture', model: body.model, choices: [{ delta: { content: reply.text ?? 'Continue.' } }] });
      events.push({ choices: [{ finish_reason: reply.tools ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1 } });
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const provider = protocol === 'anthropic'
    ? new AnthropicProvider({ apiKey: 'fixture-only', baseUrl: url })
    : new OpenAiCompatProvider({ id: 'fixture', name: 'Fixture', baseUrl: `${url}/v1` });
  const options = { provider, model: 'fixture', cwd: root, env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'state') },
    tools: ['Read'], skillCatalog: [], settingSources: [], collaboration: false,
    systemPrompt: 'Fixture.', thinking: { type: 'disabled' }, permissionMode: 'bypassPermissions',
    abortController: controller, turnEndChecks: { completion: false, openWork: false } };
  return { root, requests, options, async close() {
    controller.abort(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  } };
}

async function send(session, text) {
  await session.send(text);
  const events = [];
  for await (const event of session.stream()) events.push(event);
  const result = events.filter(event => event.type === 'result').at(-1);
  assert.equal(result?.is_error, false, result?.result);
  return events;
}

test('Read refuses empty, disguised and truncated images while delivering a valid image', { timeout: 10_000 }, async context => {
  const f = await fixture(context, 'anthropic', (body, count, root) => count === 1
    ? { tools: ['zero.png', 'fake.png', 'truncated.png', 'valid.png'].map((name, index) => ({ type: 'tool_use', id: `read-${index}`, name: 'Read', input: { file_path: join(root, name) } })) }
    : images(body).some(data => data !== png) ? { error: 'image cannot be empty or invalid' } : { text: 'Valid image delivered.' });
  let session;
  try {
    await writeFile(join(f.root, 'zero.png'), '');
    await writeFile(join(f.root, 'fake.png'), 'This is not an image.');
    await writeFile(join(f.root, 'truncated.png'), Buffer.from(png, 'base64').subarray(0, 40));
    await writeFile(join(f.root, 'valid.png'), Buffer.from(png, 'base64'));
    session = await createSession({ ...f.options, persistSession: false });
    const events = await send(session, 'Read the fixture images.');
    assert.equal(f.requests.length, 2);
    assert.deepEqual(images(f.requests[1]), [png]);
    const results = events.flatMap(event => event.type === 'user' && Array.isArray(event.message.content) ? event.message.content : []).filter(block => block.type === 'tool_result');
    assert.equal(results.length, 4);
    assert.ok(results.slice(0, 3).every(result => result.is_error === true));
  } finally { await session?.[Symbol.asyncDispose](); await f.close(); }
});

test('resuming legacy history replaces only an empty image and preserves valid image data', { timeout: 10_000 }, async context => {
  const f = await fixture(context, 'anthropic', body => images(body).some(data => !data)
    ? { error: 'image cannot be empty' } : { text: 'History remains usable.' });
  let session;
  try {
    session = await createSession({ ...f.options, persistSession: true });
    await send(session, 'Start the history.');
    const id = session.sessionId;
    await session[Symbol.asyncDispose](); session = undefined;
    const relative = (await readdir(join(f.root, 'state'), { recursive: true })).find(file => file.endsWith(`${id}.jsonl`));
    assert.ok(relative);
    const path = join(f.root, 'state', relative);
    await appendFile(path, [
      { type: 'assistant', uuid: 'legacy-call', sessionId: id, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'legacy-read', name: 'Read', input: { file_path: 'zero.png' } }] } },
      { type: 'user', uuid: 'legacy-result', sessionId: id, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'legacy-read', content: [
        { type: 'text', text: 'Recorded file reference.' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
      ] }] } },
    ].map(record => JSON.stringify(record) + '\n').join(''));
    const resumedController = new AbortController();
    context.signal.addEventListener('abort', () => resumedController.abort(), { once: true });
    session = await createSession({ ...f.options, abortController: resumedController, persistSession: true, resume: id, strictResume: true });
    await send(session, 'Continue without repeating the Read.');
    assert.equal(f.requests.length, 2);
    assert.deepEqual(images(f.requests[1]), [png]);
    assert.match(JSON.stringify(f.requests[1].messages), /Image unavailable/);
    assert.ok((await readFile(path, 'utf8')).includes('legacy-result'));
  } finally { await session?.[Symbol.asyncDispose](); await f.close(); }
});

for (const protocol of ['anthropic', 'openai']) {
  test(`${protocol} recovers once from an explicit image rejection and keeps the session usable`, { timeout: 10_000 }, async context => {
    const f = await fixture(context, protocol, (body, count, root) => count === 1
      ? { tools: [{ type: 'tool_use', id: 'read-valid', name: 'Read', input: { file_path: join(root, 'valid.png') } }] }
      : images(body).length ? { error: 'You have uploaded an unsupported image.' } : { text: 'Text conversation continues.' });
    let session;
    try {
      await writeFile(join(f.root, 'valid.png'), Buffer.from(png, 'base64'));
      session = await createSession({ ...f.options, persistSession: false });
      await send(session, 'Read the fixture image.');
      assert.equal(f.requests.length, 3);
      assert.deepEqual(images(f.requests[1]), [png]);
      assert.deepEqual(images(f.requests[2]), []);
      assert.match(JSON.stringify(f.requests[2].messages), /Do not claim visual inspection/);
      await send(session, 'Reply briefly without tools.');
      assert.equal(f.requests.length, 4);
      assert.deepEqual(images(f.requests[3]), []);
    } finally { await session?.[Symbol.asyncDispose](); await f.close(); }
  });
}

test('an image rejection stays projected out of later summaries without blocking text work', { timeout: 15_000 }, async context => {
  const root = await mkdtemp(join(tmpdir(), 'halo-image-summary-'));
  let session, workRequests = 0, summaryRequests = 0, rejectedImages = 0, compacted = false;
  const summaryImageCounts = [];
  const provider = {
    id: 'image-summary', name: 'Image summary fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: true,
      pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage(request) {
      summaryRequests++;
      const count = images({ messages: request.messages }).length;
      summaryImageCounts.push(count);
      if (count) throw new ProviderError('This model does not support image input.', { statusCode: 400 });
      return { id: 'summary', model: request.model, content: [{ type: 'text', text: 'The image was unavailable. Continue the recorded text task and constraints.' }], stopReason: 'end_turn' };
    },
    async *createMessageStream(request) {
      workRequests++;
      if (images({ messages: request.messages }).length) {
        rejectedImages++;
        throw new ProviderError('This model does not support image input.', { statusCode: 400 });
      }
      yield { type: 'message_start', id: `work-${workRequests}`, model: request.model };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Recorded evidence. '.repeat(90) } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: 'end_turn' };
      yield { type: 'message_stop' };
    },
  };
  try {
    session = await createSession({ provider, model: 'fixture', cwd: root, env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'state') },
      persistSession: false, tools: [], skillCatalog: [], settingSources: [], collaboration: false,
      systemPrompt: 'Fixture.', thinking: { type: 'disabled' }, contextWindow: 8000, maxOutputTokens: 1024,
      turnEndChecks: { completion: false, openWork: false } });
    await send(session, { role: 'user', content: [{ type: 'text', text: 'Inspect this fixture image.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] });
    for (let turn = 0; turn < 12 && !compacted; turn++) {
      const events = await send(session, `Continue ${turn}: ${'context '.repeat(180)}`);
      compacted = events.some(event => event.type === 'system' && event.subtype === 'compact_boundary');
    }
    assert.equal(compacted, true);
    assert.equal(rejectedImages, 1);
    assert.ok(summaryRequests > 0);
    assert.ok(summaryImageCounts.every(count => count === 0));
    await send(session, 'Continue the text task after the saved summary.');
  } finally {
    context.diagnostic(JSON.stringify({ workRequests, summaryRequests, summaryImageCounts, rejectedImages, compacted }));
    await session?.[Symbol.asyncDispose]();
    await rm(root, { recursive: true, force: true });
  }
});

test('a provider rejection of one image does not suppress a later valid replacement', { timeout: 10_000 }, async context => {
  const gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
  const f = await fixture(context, 'anthropic', (body, count, root) => {
    if (count === 1 || count === 4) return { tools: [{ type: 'tool_use', id: `read-${count}`, name: 'Read',
      input: { file_path: join(root, count === 1 ? 'rejected.png' : 'replacement.gif') } }] };
    if (images(body).includes(png)) return { error: 'Invalid image data.' };
    return { text: 'Continue with the available input.' };
  });
  let session;
  try {
    await writeFile(join(f.root, 'rejected.png'), Buffer.from(png, 'base64'));
    await writeFile(join(f.root, 'replacement.gif'), Buffer.from(gif, 'base64'));
    session = await createSession({ ...f.options, persistSession: false });
    await send(session, 'Read the first image.');
    assert.equal(f.requests.length, 3);
    await send(session, 'Read the valid replacement image.');
    assert.equal(f.requests.length, 5);
    assert.deepEqual(images(f.requests[4]), [gif]);
  } finally {
    context.diagnostic(JSON.stringify({ requests: f.requests.length, imageCounts: f.requests.map(request => images(request).length) }));
    await session?.[Symbol.asyncDispose]();
    await f.close();
  }
});
