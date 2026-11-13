import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const { createSdkCollaboration } = await import(pathToFileURL(join(compiled, 'native/collaboration-sdk.js')).href);
const { BudgetExceededError } = await import(pathToFileURL(join(compiled, 'utils/errors.js')).href);

test('a collaborator renders an SDK-authored callback error with its own model templates', { timeout: 10_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'halo-child-harness-error-'));
  const requests = [];
  const notices = [];
  const provider = {
    id: 'child-harness', name: 'Child Harness error fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false, pdfInput: false,
      audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { throw new Error('Unexpected summary'); },
    async *createMessageStream(request) {
      const index = requests.length;
      requests.push(structuredClone(request));
      yield { type: 'message_start', id: `child-${index}`, model: request.model, usage: { input_tokens: 2, output_tokens: 1 } };
      yield { type: 'content_block_start', index: 0, content_block: index === 0
        ? { type: 'tool_use', id: 'probe', name: 'Probe', input: {} }
        : { type: 'text', text: 'The child observed its tool refusal.' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: index === 0 ? 'tool_use' : 'end_turn' };
      yield { type: 'message_stop' };
    },
  };
  const options = { model: 'child-model', provider, cwd: directory, env: { HOME: directory }, persistSession: false,
      settingSources: [], tools: [], permissionMode: 'bypassPermissions', maxTurns: 2, turnEndChecks: { completion: false, openWork: false },
      harnessText: { models: {
        'source-model': { 'context.execution.budget': 'SOURCE_BUDGET {spent}/{maximum}' },
        'child-model': { 'context.execution.budget': 'CHILD_BUDGET {spent}/{maximum}' },
      } }, customTools: [{ name: 'Probe', description: 'Produce a typed SDK error.', inputSchema: { type: 'object' }, permissionLevel: 'none',
        async execute() { options.model = 'source-model'; throw new BudgetExceededError(1, 2); } }],
    };
  const binding = createSdkCollaboration({ sessionId: randomUUID(), settings: { maxIdleSessions: 0 },
    getOptions: () => options,
    async deliverToSource(envelope) { notices.push(envelope); return 'buffered'; },
  });
  const stop = () => { void binding.stopAll(); };
  context.signal.addEventListener('abort', stop, { once: true });
  try {
    const accepted = await binding.server.instance.callTool('spawn_agent', { name: 'reader', prompt: 'Inspect the callback error.' });
    assert.notEqual(accepted.isError, true, JSON.stringify(accepted));
    while (binding.activeCount) {
      context.signal.throwIfAborted();
      await binding.waitForChange(binding.revision, context.signal);
    }
    assert.deepEqual(requests.map(request => request.model), ['child-model', 'child-model']);
    const results = requests[1].messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_result');
    assert.equal(results.length, 1);
    assert.equal(results[0].is_error, true);
    assert.match(results[0].content, /CHILD_BUDGET 1\.0000\/2\.0000/);
    assert.doesNotMatch(results[0].content, /SOURCE_BUDGET/);
    assert.equal(options.model, 'source-model');
    assert.equal(notices.length, 1);
  } finally {
    context.signal.removeEventListener('abort', stop);
    await binding.close();
    await rm(directory, { recursive: true, force: true });
  }
});
