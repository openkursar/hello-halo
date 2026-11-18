import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { entry } from './fixtures/model-selection-entry.mjs';

async function endpoint(identity, reply) {
  const ledger = [];
  const errors = [];
  const server = createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      assert.equal(request.headers.authorization, `Bearer ${identity}-canary`);
      assert.equal(body.model, 'same-accounting-model');
      assert.doesNotMatch(raw, /[AB]-canary/);
      const result = await reply(body);
      const reportedModel = identity === 'B' ? 'child-canonical-model' : body.model;
      const usage = { prompt_tokens: body.stream ? 0 : 101 + ledger.length, completion_tokens: 7 + ledger.length };
      ledger.push({ body, usage, kind: result.partial ? 'partial' : body.stream ? 'ordinary' : 'summary' });
      if (!body.stream) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 'summary', object: 'chat.completion', model: reportedModel, choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }], usage }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: `response-${ledger.length}`, object: 'chat.completion.chunk', model: reportedModel, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      chunk(result.tool ? { role: 'assistant', tool_calls: [{ index: 0, id: result.id, type: 'function', function: { name: result.tool, arguments: JSON.stringify(result.input) } }] } : { role: 'assistant', content: result.text });
      if (!result.partial) chunk({}, result.tool ? 'tool_calls' : 'stop');
      response.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
      response.end(result.partial ? '' : 'data: [DONE]\n\n');
    } catch (error) { errors.push(error); response.writeHead(400); response.end(String(error)); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { ledger, errors, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

for (const backend of ['native', 'worker']) {
  test(`${backend}: selected binding prices ordinary, partial and summary usage at its own rate despite response alias`, { timeout: 45_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'halo-accounting-'));
    const evidence = join(directory, 'once.txt');
    const source = join(directory, 'source.txt');
    await writeFile(source, Array.from({ length: 1200 }, (_, index) => `ORIGINAL_ACCOUNTING_EVIDENCE ${index}: ${'verified detail '.repeat(12)}`).join('\n'));
    let complete;
    const completed = new Promise(resolve => { complete = resolve; });
    let step = 0;
    let summaries = 0;
    let writes = 0;
    let runtime;
    let session;
    let reference;
    const child = await endpoint('B', async body => {
      if (!body.stream) {
        summaries++;
        assert.match(JSON.stringify(body.messages), /ORIGINAL_ACCOUNTING_EVIDENCE/);
        return { text: 'SUMMARY_ACCOUNTING_EVIDENCE: Original evidence was read. Write already completed once; never replay it.' };
      }
      step++;
      if (step === 1) { writes++; return { tool: 'Write', id: 'write-once', input: { file_path: evidence, content: 'one effect' } }; }
      if (step === 2) return { tool: 'Read', id: 'read-evidence', input: { file_path: source } };
      if (step === 3) return { partial: true, text: 'ABANDONED_ACCOUNTING_TEXT' };
      assert.equal(await readFile(evidence, 'utf8'), 'one effect');
      if (summaries === 0 && step < 20) return { tool: 'Read', id: `read-evidence-${step}`, input: { file_path: source, offset: 1, limit: 200 } };
      assert.ok(summaries > 0, 'The actual loop must have invoked its nonstreaming summary provider.');
      assert.match(JSON.stringify(body.messages), /SUMMARY_ACCOUNTING_EVIDENCE/);
      complete();
      return { text: 'Child accounting complete.' };
    });
    const parent = await endpoint('A', async (_body) => {
      if (parent.ledger.length === 0) return { tool: 'mcp__halo-team__spawn_agent', id: 'spawn', input: { name: 'accounted', prompt: 'Write evidence once, read the source, and retain its evidence.', model_profile: reference } };
      let deadline;
      try { await Promise.race([completed, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(`Child did not complete: steps=${step}, summaries=${summaries}, errors=${child.errors.map(String)}`)), 15000); })]); }
      finally { clearTimeout(deadline); }
      return { text: 'Parent accounting complete.' };
    });
    t.signal.addEventListener('abort', () => { complete(); void session?.close(); }, { once: true });
    try {
      const catalog = { revision: '1', policy: 'inherit', policyRevision: '1', profiles: [{ profileId: 'B', profileRevision: '1', name: 'B', description: '', target: { kind: 'single', label: 'B', models: ['same-accounting-model'] }, reasoning: {}, available: true }] };
      const { queryModelProfiles } = await entry('collaboration');
      reference = queryModelProfiles({ catalog, parent: { bindingId: 'A', restoreRef: 'A', model: 'same-accounting-model', reasoning: { version: 1, mode: 'off' } }, policyRevision: '1', input: {} }).profiles[0].selectionRef;
      const sdk = await entry(backend);
      runtime = backend === 'native' ? sdk.createNativeRuntime() : sdk.createWorkerRuntime();
      const price = (inputPerMtk, outputPerMtk) => ({ inputPerMtk, outputPerMtk, cacheReadPerMtk: 0, cacheCreationPerMtk: 0 });
      session = await runtime.createSession({ model: 'same-accounting-model', providerConfig: { type: 'openai-compat', baseUrl: parent.url, apiKey: 'A-canary' }, modelPricing: { 'same-accounting-model': price(2, 3) }, cwd: directory, env: { HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'config') }, persistSession: false, systemPrompt: 'Delegate the accounting task.', tools: ['Write', 'Read', 'spawn_agent'], permissionMode: 'bypassPermissions', thinking: { type: 'disabled' }, collaboration: { mode: 'local', maxMembers: 2, modelSelection: { policy: 'inherit', policyRevision: '1', parentBinding: { bindingId: 'A', restoreRef: 'A' }, getCatalog: () => ({ kind: 'snapshot', catalog }), async prepare() { return { bindingId: 'B', restoreRef: 'B', model: 'same-accounting-model', targetKind: 'single', contextWindow: 40000, maxOutputTokens: 4096, modalities: ['text'], reasoning: { default: { version: 1, mode: 'off' } }, modelPricing: price(5, 11), providerConfig: { type: 'openai-compat', baseUrl: child.url, apiKey: 'B-canary' } }; } } } });
      await session.send('Delegate and verify accounting.');
      let result;
      for await (const event of session.stream()) if (event.type === 'result') { assert.equal(event.subtype, 'success', event.result); result = event; }
      assert.ok(result);
      assert.deepEqual([...parent.errors, ...child.errors], []);
      assert.equal(writes, 1);
      assert.equal(await readFile(evidence, 'utf8'), 'one effect');
      assert.equal(child.ledger.filter(item => item.kind === 'partial').length, 1);
      assert.equal(summaries, 1);
      assert.deepEqual(child.ledger.map(item => item.kind), ['ordinary', 'ordinary', 'partial', 'ordinary', 'summary', 'ordinary']);
      assert.equal(step, 5);
      assert.ok(child.ledger.every(item => item.body.max_tokens <= 4096 || item.body.max_completion_tokens <= 4096));
      assert.equal(result.usage.cache_read_input_tokens, 0);
      assert.equal(result.usage.cache_creation_input_tokens, 0);
      assert.equal(parent.ledger.length, 3, 'The parent includes one collaboration completion continuation.');
      const sum = (items, category) => items.reduce((total, item) => total + item.usage[category], 0);
      assert.equal(result.usage.input_tokens, sum([...parent.ledger, ...child.ledger], 'prompt_tokens'));
      assert.equal(result.usage.output_tokens, sum([...parent.ledger, ...child.ledger], 'completion_tokens'));
      const cost = (sum(parent.ledger, 'prompt_tokens') * 2 + sum(parent.ledger, 'completion_tokens') * 3 + sum(child.ledger, 'prompt_tokens') * 5 + sum(child.ledger, 'completion_tokens') * 11) / 1e6;
      assert.ok(Math.abs(result.total_cost_usd - cost) < 1e-12);
      assert.doesNotMatch(result.result, /ABANDONED_ACCOUNTING_TEXT/);
      console.log(JSON.stringify({ backend, summaries, childKinds: child.ledger.map(item => item.kind), usage: result.usage, cost }));
    } finally {
      complete();
      try { await session?.[Symbol.asyncDispose](); } finally {
        try { await runtime?.close(); } finally { await Promise.all([parent.close(), child.close()]); await rm(directory, { recursive: true, force: true }); }
      }
    }
  });
}
