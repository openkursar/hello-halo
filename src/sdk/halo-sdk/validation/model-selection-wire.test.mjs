import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { entry } from './fixtures/model-selection-entry.mjs';

const cases = [
  { name: 'anthropic provider-default', type: 'anthropic', reasoning: { version: 1, mode: 'provider-default' } },
  { name: 'anthropic off', type: 'anthropic', reasoning: { version: 1, mode: 'off' }, expected: { type: 'disabled' } },
  { name: 'anthropic budget', type: 'anthropic', reasoning: { version: 1, mode: 'budget', budgetTokens: 2048 }, expected: { type: 'enabled', budget_tokens: 2048 } },
  { name: 'anthropic adaptive', type: 'anthropic', reasoning: { version: 1, mode: 'adaptive', effort: 'high' }, expected: { type: 'adaptive' }, effort: 'high' },
  ...['xhigh', 'max'].map(effort => ({ name: `openai explicit ${effort}`, type: 'openai-compat', reasoning: { version: 1, mode: 'effort', effort }, effort })),
  { name: 'openai legacy root max child high', type: 'openai-compat', legacy: true, effort: 'high' },
];

for (const backend of ['native', 'worker']) for (const scenario of cases) {
  test(`${backend}: ${scenario.name}`, { timeout: 25_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'halo-selection-wire-'));
    const requests = [];
    const errors = [];
    let completed;
    const childFinished = new Promise(resolve => { completed = resolve; });
    let spawned = false;
    let reference;
    let runtime;
    let session;
    const server = createServer(async (request, response) => {
      try {
        let raw = '';
        for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw);
        const child = JSON.stringify(body.system ?? body.messages).includes('You are collaborator');
        requests.push({ child, path: request.url, body });
        let tool;
        if (child) completed();
        else if (!spawned) {
          spawned = true;
          tool = { name: 'mcp__halo-team__spawn_agent', input: { name: 'wire-child', prompt: 'Report the independent wire observation.', ...(scenario.legacy ? {} : { model_profile: reference, ...(scenario.type === 'openai-compat' ? { reasoning_effort: scenario.effort } : {}) }) } };
        } else {
          assert.doesNotMatch(JSON.stringify(body.messages), /MODEL_SELECTION_|COLLABORATION_ARGUMENTS|isError\\\":true/, 'Spawn must not be rejected.');
          await childFinished;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        if (scenario.type === 'anthropic') {
          const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
          event('message_start', { message: { id: 'wire-msg', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 5, output_tokens: 0 } } });
          event('content_block_start', { index: 0, content_block: tool ? { type: 'tool_use', id: 'wire-spawn', name: tool.name, input: {} } : { type: 'text', text: '' } });
          event('content_block_delta', { index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } : { type: 'text_delta', text: 'Wire observation completed.' } });
          event('content_block_stop', { index: 0 });
          event('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
          event('message_stop', {});
          response.end();
        } else {
          const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'wire-msg', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
          chunk(tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'wire-spawn', type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] } : { role: 'assistant', content: 'Wire observation completed.' });
          chunk({}, tool ? 'tool_calls' : 'stop');
          response.end('data: [DONE]\n\n');
        }
      } catch (error) {
        errors.push(error);
        completed();
        response.writeHead(500);
        response.end(String(error));
      }
    });
    t.signal.addEventListener('abort', () => { completed(); void session?.close(); server.closeAllConnections(); }, { once: true });
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const providerConfig = { type: scenario.type, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'wire-synthetic', quirks: { reasoningEffort: true } };
      const catalog = { revision: '1', policyRevision: '1', policy: 'inherit', profiles: [{ profileId: 'wire', profileRevision: '1', name: 'Wire', description: '', target: { kind: 'single', label: 'Wire', models: ['wire-model'] }, reasoning: { supported: ['high', 'xhigh', 'max'] }, available: true }] };
      const parent = { bindingId: 'root', restoreRef: 'root', model: 'wire-model', reasoning: { version: 1, mode: 'off' } };
      const { queryModelProfiles } = await entry('collaboration');
      reference = queryModelProfiles({ catalog, parent, policyRevision: '1', input: {} }).profiles[0].selectionRef;
      const sdk = await entry(backend);
      runtime = backend === 'worker' ? sdk.createWorkerRuntime() : sdk.createNativeRuntime();
      session = await runtime.createSession({ model: 'wire-model', providerConfig, cwd: directory, env: { HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'config') }, persistSession: false, systemPrompt: 'Delegate the wire observation.', permissionMode: 'bypassPermissions', tools: ['spawn_agent'], thinking: scenario.legacy ? { type: 'adaptive' } : { type: 'disabled' }, ...(scenario.legacy ? { effort: 'max' } : {}), collaboration: { mode: 'local', maxMembers: 2, ...(scenario.legacy ? {} : { modelSelection: { parentBinding: { bindingId: 'root', restoreRef: 'root' }, policy: 'inherit', policyRevision: '1', getCatalog: () => ({ kind: 'snapshot', catalog }), async prepare() { return { bindingId: 'child', restoreRef: 'child', model: 'wire-model', targetKind: 'single', contextWindow: 32000, maxOutputTokens: 8192, modalities: ['text'], reasoning: { default: scenario.reasoning, supported: ['high', 'xhigh', 'max'], modes: ['provider-default', 'off', 'budget', 'adaptive', 'effort'], maxBudgetTokens: 4096 }, providerConfig }; } } }) } });
      await session.send('Delegate an independent observation.');
      let terminal = false;
      for await (const event of session.stream()) if (event.type === 'result') { assert.equal(event.subtype, 'success', JSON.stringify(event)); terminal = true; }
      assert.ok(terminal);
      assert.deepEqual(errors, [], 'The local protocol peer must not fail.');
      const children = requests.filter(request => request.child);
      assert.ok(children.length > 0, 'Actual child HTTP request required.');
      for (const { body } of children) {
        assert.equal(body.model, 'wire-model');
        if (scenario.type === 'anthropic') {
          if (scenario.expected) assert.deepEqual(body.thinking, scenario.expected);
          else assert.equal(Object.hasOwn(body, 'thinking'), false, 'Provider-default must omit thinking.');
          if (scenario.effort) assert.equal(body.output_config?.effort, scenario.effort);
          else assert.equal(Object.hasOwn(body.output_config ?? {}, 'effort'), false, 'No stale effort.');
        } else assert.equal(body.reasoning_effort, scenario.effort);
      }
      if (scenario.legacy) assert.ok(requests.filter(request => !request.child).every(({ body }) => body.reasoning_effort === 'high'), 'Legacy max maps to actual high before inheritance.');
    } finally {
      completed();
      try { await session?.[Symbol.asyncDispose](); } finally {
        try { await runtime?.close(); } finally {
          await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
          await rm(directory, { recursive: true, force: true });
        }
      }
    }
  });
}
