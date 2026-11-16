import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createModelServer, completionEvents, sendSse } from './fixtures/model-server.mjs';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const { AnthropicProvider, OpenAiCompatProvider } = await import(pathToFileURL(join(compiled, 'index.js')).href);
const request = { model: 'fixture', maxTokens: 64, stream: false, messages: [{ role: 'user', content: 'Hello' }] };

for (const protocol of ['anthropic', 'openai']) {
  test(`${protocol} public provider retains actual authorization, request fields and returned usage`, { timeout: 10000 }, async t => {
    const server = await createModelServer((_request, response, body) => {
      if (body.stream) {
        sendSse(response, protocol === 'anthropic' ? [
          { type: 'message_start', message: { id: 'fixture-response', type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 17, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reply' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
          { type: 'message_stop' },
        ] : completionEvents(protocol, { content: 'Reply' }, 17, 3));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(protocol === 'anthropic'
        ? { id: 'fixture-response', type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'Reply' }],
          stop_reason: 'end_turn', usage: { input_tokens: 17, output_tokens: 3 } }
        : { id: 'fixture-response', model: 'fixture', choices: [{ message: { role: 'assistant', content: 'Reply' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 17, completion_tokens: 3 } }));
    });
    t.after(() => server.close());
    const provider = protocol === 'anthropic'
      ? new AnthropicProvider({ apiKey: 'fixture-only', baseUrl: server.url })
      : new OpenAiCompatProvider({ id: 'fixture', name: 'Fixture', apiKey: 'fixture-only', baseUrl: `${server.url}/v1` });
    const input = { ...request, temperature: 0.3, providerOptions: protocol === 'anthropic' ? { taskBudget: { total: 12000 } } : {} };
    const original = structuredClone(input);
    const result = await provider.createMessage(input);
    assert.deepEqual(input, original);
    assert.equal(result.content.find(block => block.type === 'text').text, 'Reply');
    assert.equal(result.usage.input_tokens, 17);
    assert.equal(result.usage.output_tokens, 3);
    assert.equal(server.requests.length, 1);
    const wire = server.requests[0];
    assert.equal(wire.body.model, 'fixture');
    assert.equal(wire.body.temperature, 0.3);
    assert.equal(wire.body.max_tokens, 64);
    if (protocol === 'anthropic') {
      assert.equal(wire.headers['x-api-key'], 'fixture-only');
      assert.deepEqual(wire.body.output_config.task_budget, { type: 'tokens', total: 12000 });
      assert.ok(wire.headers['anthropic-beta'].split(',').includes('task-budgets-2026-03-13'));
    } else {
      assert.equal(wire.headers.authorization, 'Bearer fixture-only');
      assert.equal(wire.body.messages[0].content, 'Hello');
    }
  });

  test(`${protocol} public model listing returns an empty list on HTTP refusal`, { timeout: 10000 }, async t => {
    const server = await createModelServer((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Fixture refusal' } }));
    });
    t.after(() => server.close());
    const provider = protocol === 'anthropic'
      ? new AnthropicProvider({ apiKey: 'fixture-only', baseUrl: server.url })
      : new OpenAiCompatProvider({ id: 'fixture', name: 'Fixture', apiKey: 'fixture-only', baseUrl: `${server.url}/v1` });
    assert.deepEqual(await provider.listModels(), []);
    assert.equal(server.requests.length, 1);
    assert.ok(new URL(server.requests[0].path, server.url).pathname.endsWith('/models'));
  });
}
