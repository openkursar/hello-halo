import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entry } from './fixtures/model-selection-entry.mjs';

for (const backend of ['native', 'worker']) {
  test(`${backend}: overlapping custom sibling streams retain distinct same-model bindings`, { timeout: 30_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'halo-selection-siblings-'));
    let runtime;
    let session;
    let preparations = 0;
    try {
      const catalog = { revision: '1', policy: 'inherit', policyRevision: '1', profiles: ['B', 'C'].map(profileId => ({ profileId, profileRevision: '1', name: profileId, description: 'Parallel verification', target: { kind: 'single', label: profileId, models: ['same-model'] }, reasoning: {}, available: true })) };
      const parent = { bindingId: 'root', restoreRef: 'root-restore', model: 'same-model', reasoning: { version: 1, mode: 'off' } };
      const { queryModelProfiles } = await entry('collaboration');
      const refs = Object.fromEntries(queryModelProfiles({ catalog, parent, policyRevision: '1', input: {} }).profiles.map(profile => [profile.name, profile.selectionRef]));
      const sdk = await entry(backend);
      runtime = (backend === 'native' ? sdk.createNativeRuntime : sdk.createWorkerRuntime)({ setup: { module: new URL('./fixtures/model-selection-concurrent-setup.mjs', import.meta.url).href, data: { refs } } });
      session = await runtime.createSession({ model: 'same-model', cwd: directory, env: { HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'config') }, systemPrompt: 'Concurrent sibling verification.', tools: ['spawn_agent'], permissionMode: 'bypassPermissions', thinking: { type: 'disabled' }, persistSession: false, collaboration: { mode: 'local', maxMembers: 3, maxConcurrentTurns: 3, modelSelection: { policy: 'inherit', policyRevision: '1', parentBinding: { bindingId: 'root', restoreRef: 'root-restore' }, getCatalog() { return { kind: 'snapshot', catalog }; }, async prepare(request, { signal }) { signal.throwIfAborted(); preparations++; return { bindingId: request.plan.selection.profileId, restoreRef: `${request.plan.selection.profileId}-restore`, model: 'same-model', targetKind: 'single', contextWindow: 32000, maxOutputTokens: 1024, modalities: ['text'], reasoning: { default: { version: 1, mode: 'off' } }, providerConfig: { type: 'openai-compat', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'unused' } }; } } } });
      t.signal.addEventListener('abort', () => { void session.close(); }, { once: true });
      await session.send('Start both siblings.');
      let result;
      for await (const event of session.stream()) if (event.type === 'result') { assert.equal(event.subtype, 'success', event.result); result = event; }
      assert.equal(preparations, 2);
      assert.ok(result, 'The source must publish a terminal result.');
      assert.match(result.result, /Both siblings overlapped/);
      assert.ok(result.usage.input_tokens >= 15);
    } finally {
      try { await session?.[Symbol.asyncDispose](); } finally {
        try { await runtime?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
      }
    }
  });
}
