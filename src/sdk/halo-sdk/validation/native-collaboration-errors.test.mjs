import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const { createSdkCollaboration } = await import(pathToFileURL(join(compiled, process.env.SDK_COLLABORATION_ENTRY ?? 'native/collaboration-sdk.js')).href);
const { ProviderError, ModelFallbackError } = await import(pathToFileURL(join(compiled, 'utils/errors.js')).href);
const capabilities = () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false, pdfInput: false,
  audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' });

for (const [kind, expectedModels, fail] of [
  ['exhausted-provider-budget', ['primary', 'fallback'], () => new ProviderError('The provider already exhausted its retries.', { statusCode: 503, retryable: true, retriesExhausted: true })],
  ['model-fallback', ['primary', 'fallback'], () => new ModelFallbackError('Switch away from the overloaded model.', { statusCode: 529 })],
  ['status-bearing-error', ['primary', 'primary'], () => Object.assign(new Error('A temporary upstream failure.'), { status: 503 })],
  ['exhausted-without-fallback', ['primary'], () => new ProviderError('The provider already exhausted its retries.', { statusCode: 429, retryable: true, retriesExhausted: true })],
]) {
  test(`collaborator preserves ${kind} through its callback owner without spending another turn or usage budget`, { timeout: 10_000 }, async context => {
    const directory = await mkdtemp(join(tmpdir(), 'halo-child-errors-'));
    const requests = [];
    const notices = [];
    const provider = {
      id: 'child-error', name: 'Child error fixture', capabilities,
      async createMessage() { throw new Error('Unexpected summary'); },
      async *createMessageStream(request) {
        requests.push(structuredClone(request));
        if (requests.length === 1) throw fail();
        yield { type: 'message_start', id: 'recovered', model: request.model, usage: { input_tokens: 7, output_tokens: 3 } };
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'RECOVERED_CHILD_RESULT' } };
        yield { type: 'content_block_stop', index: 0 };
        yield { type: 'message_delta', stopReason: 'end_turn' };
        yield { type: 'message_stop' };
      },
    };
    const price = { inputPerMtk: 1, outputPerMtk: 1, cacheCreationPerMtk: 1, cacheReadPerMtk: 1 };
    const binding = createSdkCollaboration({ sessionId: randomUUID(), settings: { maxIdleSessions: 0 },
      getOptions: () => ({ model: 'primary', ...(kind === 'exhausted-without-fallback' ? {} : { fallbackModel: 'fallback' }), provider,
        modelPricing: { primary: price, fallback: price }, maxBudgetUsd: 0.00002, maxTurns: 1,
        cwd: directory, env: { HOME: directory }, persistSession: false, settingSources: [], tools: [],
        thinking: { type: 'disabled' }, permissionMode: 'bypassPermissions', turnEndChecks: { completion: false, openWork: false } }),
      async deliverToSource(envelope) { notices.push(envelope); return 'buffered'; },
    });
    const stop = () => { void binding.stopAll(); };
    context.signal.addEventListener('abort', stop, { once: true });
    try {
      const accepted = await binding.server.instance.callTool('spawn_agent', { name: 'reader', prompt: 'Complete the bounded work.' });
      assert.notEqual(accepted.isError, true, JSON.stringify(accepted));
      while (binding.activeCount) {
        context.signal.throwIfAborted();
        await binding.waitForChange(binding.revision, context.signal);
      }
      assert.deepEqual(requests.map(request => request.model), expectedModels);
      assert.equal(notices.length, 1);
      const succeeded = expectedModels.length === 2;
      assert.equal(notices[0].body.includes('RECOVERED_CHILD_RESULT'), succeeded);
      const usage = binding.drainUsage();
      const totals = Object.values(usage).reduce((sum, value) => ({ input: sum.input + value.input_tokens, output: sum.output + value.output_tokens,
        cost: sum.cost + value.total_cost_usd }), { input: 0, output: 0, cost: 0 });
      assert.deepEqual([totals.input, totals.output], succeeded ? [7, 3] : [0, 0]);
      assert.ok(Math.abs(totals.cost - (succeeded ? 0.00001 : 0)) < 1e-12);
      assert.ok(Math.abs(binding.budget.total - totals.cost) < 1e-12);
      assert.deepEqual(binding.drainUsage(), {});
      assert.equal(binding.residentCount, 0);
    } finally {
      context.signal.removeEventListener('abort', stop);
      await binding.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
