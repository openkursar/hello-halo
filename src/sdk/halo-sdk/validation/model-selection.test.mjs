import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { entry, entryUrl } from './fixtures/model-selection-entry.mjs';

async function endpoint(reply) {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      let encoded = '';
      for await (const chunk of request) encoded += chunk;
      const body = JSON.parse(encoded);
      requests.push({ body, authorization: request.headers.authorization });
      const message = await reply(body, requests.length);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'local-response', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (message.tool) {
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: message.id, type: 'function', function: { name: message.tool, arguments: JSON.stringify(message.input) } }] });
        chunk({}, 'tool_calls');
      } else {
        chunk({ role: 'assistant', content: message.text });
        chunk({}, 'stop');
      }
      response.write(`data: ${JSON.stringify({ id: 'local-response', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 13, completion_tokens: 7, total_tokens: 20 } })}\n\n`);
      response.end('data: [DONE]\n\n');
    } catch (error) {
      response.writeHead(500); response.end(String(error));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

for (const backend of ['native', 'worker']) {
  for (const customProvider of [false, true]) {
  test(`${backend} ${customProvider ? 'custom' : 'standard'}: selected child uses its own endpoint and credentials; parent remains unchanged`, { timeout: 45_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'halo-model-selection-'));
    const evidence = join(directory, 'child.txt');
    let childDone;
    const finished = new Promise(resolve => { childDone = resolve; });
    let runtime;
    let session;
    let grandchildDone;
    const nestedFinished = new Promise(resolve => { grandchildDone = resolve; });
    let childStep = 0;
    let grandchildRequests = 0;
    const child = await endpoint(async body => {
      const grandchild = body.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('NESTED_INHERITANCE_EVIDENCE'));
      if (grandchild) {
        grandchildRequests++;
        grandchildDone();
        return { text: 'Grandchild inherited the direct child binding.' };
      }
      childStep++;
      if (childStep === 1) return { tool: 'Write', id: 'child-write', input: { file_path: evidence, content: 'selected child executed' } };
      assert.equal(await readFile(evidence, 'utf8'), 'selected child executed');
      if (childStep === 2) return { tool: 'mcp__halo-team__spawn_agent', id: 'nested-spawn', input: { name: 'nested', prompt: 'NESTED_INHERITANCE_EVIDENCE: verify direct-parent inheritance without changing model.' } };
      await nestedFinished;
      childDone();
      return { text: 'Child evidence is complete.' };
    });
    const parent = await endpoint(async (body, step) => {
      if (step === 1) return { tool: 'mcp__halo-team__spawn_agent', id: 'selected-spawn', input: { name: 'selected', prompt: 'Write and verify the evidence.', model_profile: selectionRef } };
      const receipt = body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'selected-spawn');
      assert.ok(receipt, 'The parent must receive its spawn receipt.');
      assert.doesNotMatch(JSON.stringify(receipt), /isError.*true|MODEL_SELECTION_|COLLABORATION_ARGUMENTS/, 'The selected spawn must be accepted.');
      await finished;
      return { text: 'Parent observed child completion.' };
    });
    const catalog = { revision: 'catalog-1', policyRevision: 'policy-1', policy: 'inherit', profiles: [{ profileId: 'child', profileRevision: '1', name: 'Selected child', description: 'Write evidence.', target: { kind: 'single', label: 'Child endpoint', models: ['same-wire-model'] }, reasoning: {}, available: true }] };
    const { queryModelProfiles } = await entry('collaboration');
    const parentBinding = { bindingId: 'parent-account', restoreRef: 'parent-restore', model: 'same-wire-model', reasoning: { version: 1, mode: 'off' } };
    const page = queryModelProfiles({ catalog, parent: parentBinding, policyRevision: 'policy-1', input: {} });
    const selectionRef = page.profiles[0].selectionRef;
    let preparations = 0;
    let catalogCalls = 0;
    try {
      const sdk = await entry(backend);
      const runtimeOptions = customProvider ? { setup: { module: new URL('./fixtures/model-selection-setup.mjs', import.meta.url).href, data: { nativeEntry: entryUrl('native') } } } : {};
      runtime = backend === 'worker' ? sdk.createWorkerRuntime(runtimeOptions) : sdk.createNativeRuntime(runtimeOptions);
      session = await runtime.createSession({ model: 'same-wire-model', providerConfig: { type: 'openai-compat', baseUrl: parent.url, apiKey: 'parent-secret-canary' }, cwd: directory, env: { HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'config') }, systemPrompt: 'Exercise the requested delegation.', permissionMode: 'bypassPermissions', tools: ['Write', 'spawn_agent'], thinking: { type: 'disabled' }, persistSession: false, modelPricing: { 'same-wire-model': { inputPerMtk: 1, outputPerMtk: 2, cacheCreationPerMtk: 0, cacheReadPerMtk: 0 } },
        collaboration: { mode: 'local', maxMembers: 3, maxConcurrentTurns: 3, modelSelection: { policy: 'inherit', policyRevision: 'policy-1', parentBinding: { bindingId: parentBinding.bindingId, restoreRef: parentBinding.restoreRef }, getCatalog() { catalogCalls++; return { kind: 'snapshot', catalog }; }, async prepare(request, { signal }) { signal.throwIfAborted(); preparations++; assert.equal(request.kind, 'new'); if (request.plan.selection.kind === 'profile') assert.equal(request.plan.selection.profileId, 'child');
          else assert.equal(request.plan.parent.bindingId, 'child-account'); return { bindingId: 'child-account', restoreRef: 'child-restore', model: 'same-wire-model', targetKind: 'single', contextWindow: 32000, maxOutputTokens: 1024, modalities: ['text'], reasoning: { default: { version: 1, mode: 'off' } }, modelPricing: { inputPerMtk: 3, outputPerMtk: 5, cacheCreationPerMtk: 0, cacheReadPerMtk: 0 }, providerConfig: { type: 'openai-compat', baseUrl: child.url, apiKey: 'child-secret-canary' } }; } } } });
      t.signal.addEventListener('abort', () => { childDone(); session?.close(); }, { once: true });
      await session.send('Delegate using the selected model profile.');
      let result;
      for await (const event of session.stream()) if (event.type === 'result') {
        assert.equal(event.subtype, 'success', event.result);
        result = event;
      }
      assert.equal(await readFile(evidence, 'utf8'), 'selected child executed');
      assert.equal(preparations, 2);
      assert.ok(grandchildRequests > 0, 'Nested child must execute on the selected child endpoint.');
      assert.ok(catalogCalls >= 1);
      assert.ok(child.requests.length >= 2);
      assert.ok(parent.requests.length >= 2);
      assert.ok(child.requests.every(request => request.authorization === 'Bearer child-secret-canary' && request.body.model === 'same-wire-model'));
      assert.ok(parent.requests.every(request => request.authorization === 'Bearer parent-secret-canary' && request.body.model === 'same-wire-model'));
      const allBodies = [...parent.requests, ...child.requests].map(request => request.body);
      assert.ok(!JSON.stringify(allBodies).includes('child-secret-canary'));
      assert.ok(!JSON.stringify(allBodies).includes('parent-secret-canary'));
      assert.ok(result, 'The source must publish a terminal result.');
      const requestCount = parent.requests.length + child.requests.length;
      assert.equal(result.usage.input_tokens, requestCount * 13, 'Child usage must reach the source exactly once.');
      assert.equal(result.usage.output_tokens, requestCount * 7);
      const expectedCost = (parent.requests.length * (13 + 7 * 2) + child.requests.length * (13 * 3 + 7 * 5)) / 1_000_000;
      assert.ok(Math.abs(result.total_cost_usd - expectedCost) < 1e-12, 'Usage must retain each execution target price before same-model aggregation.');
      assert.ok(child.requests.every(request => request.body.max_tokens === 1024 || request.body.max_completion_tokens === 1024), 'The selected target output limit must replace the parent limit.');
    } finally {
      childDone();
      grandchildDone();
      await session?.[Symbol.asyncDispose]();
      await runtime?.close();
      await Promise.all([parent.close(), child.close()]);
      await rm(directory, { recursive: true, force: true });
    }
  });
  }

  test(`${backend}: closing during preparation cancels the host and never starts a late child`, { timeout: 30_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'halo-selection-cancel-'));
    let entered;
    let release;
    let cancelled;
    const preparation = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const observedCancel = new Promise(resolve => { cancelled = resolve; });
    const child = await endpoint(async () => ({ text: 'A canceled child must not be requested.' }));
    const catalog = { revision: '1', policyRevision: '1', policy: 'inherit', profiles: [] };
    const parent = await endpoint(async (_body, step) => step === 1
      ? { tool: 'mcp__halo-team__spawn_agent', id: 'pending-spawn', input: { name: 'pending', prompt: 'This preparation will be canceled.' } }
      : { text: 'No late child.' });
    let runtime;
    let session;
    let survivor;
    let consuming;
    try {
      const sdk = await entry(backend);
      runtime = backend === 'worker' ? sdk.createWorkerRuntime() : sdk.createNativeRuntime();
      session = await runtime.createSession({ model: 'cancel-model', providerConfig: { type: 'openai-compat', baseUrl: parent.url, apiKey: 'parent-cancel' }, cwd: directory, env: { HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'config') }, persistSession: false, systemPrompt: 'Exercise cancellation.', permissionMode: 'bypassPermissions', tools: ['spawn_agent'], thinking: { type: 'disabled' }, collaboration: { mode: 'local', modelSelection: { policy: 'inherit', policyRevision: '1', parentBinding: { bindingId: 'parent', restoreRef: 'parent-restore' }, getCatalog() { return { kind: 'snapshot', catalog }; }, async prepare(_request, { signal }) { signal.addEventListener('abort', cancelled, { once: true }); if (signal.aborted) cancelled(); entered(); await gate; return { bindingId: 'parent', restoreRef: 'parent-restore', model: 'cancel-model', targetKind: 'single', contextWindow: 32000, maxOutputTokens: 1024, modalities: ['text'], reasoning: { default: { version: 1, mode: 'off' } }, providerConfig: { type: 'openai-compat', baseUrl: child.url, apiKey: 'never-request' } }; } } } });
      t.signal.addEventListener('abort', () => { release(); session?.close(); }, { once: true });
      await session.send('Start the pending delegation.');
      consuming = (async () => { for await (const _event of session.stream()) {} })();
      void consuming.catch(() => undefined);
      await preparation;
      const closing = session[Symbol.asyncDispose]();
      await observedCancel;
      release();
      await closing;
      await consuming.catch(() => undefined);
      assert.equal(child.requests.length, 0, 'A result arriving after cancellation must not start its provider.');
      survivor = await runtime.createSession({ model: 'survivor', providerConfig: { type: 'openai-compat', baseUrl: parent.url, apiKey: 'survivor' }, cwd: directory, env: { HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'survivor') }, persistSession: false, collaboration: { mode: 'hosted' }, thinking: { type: 'disabled' } });
      await survivor.send('Verify the shared execution environment is still usable.');
      let completed = false;
      for await (const event of survivor.stream()) if (event.type === 'result') { assert.equal(event.subtype, 'success', event.result); completed = true; }
      assert.ok(completed, 'Closing one session must not terminate the shared Worker or runtime.');
    } finally {
      release();
      await survivor?.[Symbol.asyncDispose]();
      await session?.[Symbol.asyncDispose]();
      await runtime?.close();
      await Promise.all([parent.close(), child.close()]);
      await rm(directory, { recursive: true, force: true });
    }
  });

  for (const effort of ['low', 'high']) {
    test(`${backend}: unregistered model selection preserves parent ${effort} on child wire requests`, { timeout: 30_000 }, async t => {
      const directory = await mkdtemp(join(tmpdir(), 'halo-reasoning-inheritance-'));
      let childDone;
      const finished = new Promise(resolve => { childDone = resolve; });
      let delegated = false;
      const childRequests = [];
      const service = await endpoint(async body => {
        const child = JSON.stringify(body.messages).includes('You are collaborator');
        if (child) {
          childRequests.push(body);
          childDone();
          return { text: 'Inherited child reasoning observed.' };
        }
        if (!delegated) {
          delegated = true;
          const schema = body.tools.find(tool => tool.function.name === 'mcp__halo-team__spawn_agent').function.parameters;
          assert.ok(!Object.hasOwn(schema.properties, 'model_profile'));
          assert.ok(!Object.hasOwn(schema.properties, 'reasoning_effort'));
          assert.ok(!body.tools.some(tool => tool.function.name.endsWith('list_model_profiles')));
          return { tool: 'mcp__halo-team__spawn_agent', id: 'inherit-spawn', input: { name: 'inherited', prompt: 'Complete the independent evidence check.' } };
        }
        await finished;
        return { text: 'Inherited reasoning was observed.' };
      });
      let runtime;
      let session;
      try {
        const sdk = await entry(backend);
        runtime = backend === 'worker' ? sdk.createWorkerRuntime() : sdk.createNativeRuntime();
        session = await runtime.createSession({ model: 'reasoning-model', providerConfig: { type: 'openai-compat', baseUrl: service.url, apiKey: 'reasoning-canary', quirks: { reasoningEffort: true } }, cwd: directory, env: { HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'config') }, systemPrompt: 'Delegate the independent evidence check.', permissionMode: 'bypassPermissions', tools: ['spawn_agent'], thinking: { type: 'adaptive' }, effort, persistSession: false, collaboration: { mode: 'local', maxMembers: 2 } });
        t.signal.addEventListener('abort', () => { childDone(); session?.close(); }, { once: true });
        await session.send('Delegate the check without changing its model or reasoning.');
        for await (const event of session.stream()) if (event.type === 'result') assert.equal(event.subtype, 'success', event.result);
        assert.ok(childRequests.length > 0, 'A real child provider request must occur.');
        assert.ok(childRequests.every(request => request.reasoning_effort === effort));
        assert.ok(service.requests.every(request => request.body.reasoning_effort === effort));
      } finally {
        childDone();
        await session?.[Symbol.asyncDispose]();
        await runtime?.close();
        await service.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}

test('standalone selected binding survives idle retirement and profile deletion without replay', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'halo-selection-restore-'));
  const output = join(directory, 'once.txt');
  let step = 0;
  const service = await endpoint(async body => {
    step++;
    if (step === 1) return { tool: 'Write', id: 'write-once', input: { file_path: output, content: 'original effect' } };
    assert.equal(await readFile(output, 'utf8'), 'original effect');
    if (step > 2) assert.ok(JSON.stringify(body.messages).includes('write-once'), 'Restoration must retain the existing tool transcript.');
    return { text: 'Original binding and retained evidence verified.' };
  });
  const { createSdkCollaboration } = await entry('collaboration/sdk');
  const { queryModelProfiles } = await entry('collaboration');
  let catalog = { revision: '1', policy: 'inherit', policyRevision: '1', profiles: [{ profileId: 'original', profileRevision: '1', name: 'Original profile', description: '', target: { kind: 'single', label: 'Original endpoint', models: ['restore-model'] }, reasoning: {}, available: true }] };
  const parent = { bindingId: 'parent', restoreRef: 'parent-restore', model: 'parent-model', reasoning: { version: 1, mode: 'off' } };
  const reference = queryModelProfiles({ catalog, parent, policyRevision: '1', input: {} }).profiles[0].selectionRef;
  const prepared = [];
  const binding = createSdkCollaboration({ sessionId: 'restore-source', getOptions: () => ({ model: 'parent-model', cwd: directory, env: { HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'config') }, permissionMode: 'bypassPermissions', systemPrompt: 'Retain evidence.', tools: ['Write', 'spawn_agent'], thinking: { type: 'disabled' }, persistSession: false }), settings: { maxMembers: 2, maxIdleSessions: 0, modelSelection: { policy: 'inherit', policyRevision: '1', parentBinding: { bindingId: 'parent', restoreRef: 'parent-restore' }, getCatalog: () => ({ kind: 'snapshot', catalog }), async prepare(request, { signal }) { signal.throwIfAborted(); prepared.push(structuredClone(request)); return { bindingId: 'original-account', restoreRef: 'original-restore', model: 'restore-model', targetKind: 'single', contextWindow: 32000, maxOutputTokens: 1024, modalities: ['text'], reasoning: { default: { version: 1, mode: 'off' } }, providerConfig: { type: 'openai-compat', baseUrl: service.url, apiKey: 'restore-canary' } }; } } }, async deliverToSource() { return 'buffered'; } });
  t.signal.addEventListener('abort', () => { void binding.close(); }, { once: true });
  const idle = async () => {
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Collaborator did not become idle.')), 10_000);
      const inspect = async () => {
        try {
          while (binding.activeCount > 0) await binding.waitForChange(binding.revision, t.signal);
          clearTimeout(deadline); resolve();
        } catch (error) { clearTimeout(deadline); reject(error); }
      };
      void inspect();
    });
  };
  try {
    const spawned = await binding.server.instance.callTool('spawn_agent', { name: 'retained', prompt: 'Write the evidence once.', model_profile: reference });
    assert.notEqual(spawned.isError, true, JSON.stringify(spawned));
    await idle();
    assert.equal(binding.residentCount, 0);
    assert.equal(step, 2);
    catalog = { ...catalog, revision: '2', profiles: [] };
    const continued = await binding.server.instance.callTool('team_send', { to: 'retained', message: 'Verify the existing evidence without replaying Write.' });
    assert.notEqual(continued.isError, true, JSON.stringify(continued));
    await idle();
    assert.equal(step, 3);
    assert.deepEqual(prepared.map(request => request.kind), ['new', 'restore']);
    assert.equal(prepared[1].snapshot.bindingId, 'original-account');
    assert.equal(prepared[1].snapshot.restoreRef, 'original-restore');
    assert.ok(service.requests.every(request => request.authorization === 'Bearer restore-canary' && request.body.model === 'restore-model'));
    assert.equal(await readFile(output, 'utf8'), 'original effect');
  } finally {
    await binding.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an exact child binding cannot use a parent fallback model', { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'halo-selection-fallback-'));
  const { createSdkCollaboration } = await entry('collaboration/sdk');
  const requests = [];
  const catalog = { revision: '1', policy: 'inherit', policyRevision: '1', profiles: [] };
  const binding = createSdkCollaboration({
    sessionId: 'fallback-source',
    getOptions: () => ({ model: 'bound-child', fallbackModel: 'root-fallback', cwd: directory, persistSession: false,
      env: { HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'config') }, thinking: { type: 'disabled' } }),
    settings: { modelSelection: {
      policy: 'inherit', policyRevision: '1', parentBinding: { bindingId: 'parent', restoreRef: 'parent' },
      getCatalog: () => ({ kind: 'snapshot', catalog }),
      async prepare() {
        return { bindingId: 'parent', restoreRef: 'parent', model: 'bound-child', targetKind: 'single',
          contextWindow: 32000, maxOutputTokens: 1024, modalities: ['text'], reasoning: { default: { version: 1, mode: 'off' } },
          provider: {
            id: 'fallback-fixture', name: 'Fallback fixture',
            capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, caching: false }),
            async *createMessageStream(request) {
              requests.push({ model: request.model, fallback: request.providerOptions.fallbackModelAvailable });
              const error = new Error('The bound provider requested a fallback.');
              error.name = 'ModelFallbackError';
              error.retryable = true;
              error.retriesExhausted = true;
              throw error;
            },
          },
        };
      },
    } },
    async deliverToSource() { return 'buffered'; },
  });
  t.signal.addEventListener('abort', () => { void binding.close(); }, { once: true });
  try {
    const spawned = await binding.server.instance.callTool('spawn_agent', { name: 'bound', prompt: 'Verify the configured model.' });
    assert.notEqual(spawned.isError, true, JSON.stringify(spawned));
    while (binding.activeCount > 0) {
      const revision = binding.revision;
      if (binding.activeCount > 0) await binding.waitForChange(revision, t.signal);
    }
    assert.deepEqual(requests, [{ model: 'bound-child', fallback: false }]);
  } finally {
    await binding.close();
    await rm(directory, { recursive: true, force: true });
  }
});
