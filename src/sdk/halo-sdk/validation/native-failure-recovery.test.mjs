import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createModelServer } from './fixtures/model-server.mjs';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const { createSession } = await import(pathToFileURL(join(compiled, 'index.js')).href);
const deadline = { timeout: 15_000 };
const capabilities = { streaming: true, toolCalling: true, thinking: false, imageInput: false,
  pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' };
const call = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const text = value => ({ type: 'text', text: value });
const blocks = request => request.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
const outcome = (request, id) => blocks(request).find(block => block.type === 'tool_result' && block.tool_use_id === id);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

function provider(script, requests) {
  return { id: 'fixture', name: 'Fixture', capabilities: () => capabilities,
    async createMessage() { throw new Error('Unexpected summary request'); },
    async *createMessageStream(request) {
      requests.push(request);
      const content = await script(request, requests.length);
      yield { type: 'message_start', id: 'fixture-response', model: request.model, usage: { input_tokens: 10, output_tokens: 0 } };
      for (const [index, content_block] of content.entries()) {
        yield { type: 'content_block_start', index, content_block };
        yield { type: 'content_block_stop', index };
      }
      yield { type: 'message_delta', stopReason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { output_tokens: 2 } };
      yield { type: 'message_stop' };
    } };
}

async function collect(session, prompt = 'Run the fixture.') {
  await session.send(prompt);
  const events = [];
  for await (const event of session.stream()) events.push(event);
  assert.equal(events.filter(event => event.type === 'result').length, 1);
  assert.equal(events.at(-1).state, 'idle');
  return { events, result: events.findLast(event => event.type === 'result') };
}

async function fixture(t, script, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'halo-native-failure-'));
  const requests = [];
  let session;
  t.after(async () => { await session?.[Symbol.asyncDispose](); await rm(root, { recursive: true, force: true }); });
  t.signal.addEventListener('abort', () => session?.close(), { once: true });
  const options = { model: 'fixture', cwd: root, provider: provider((request, count) => script(request, count, root), requests),
    env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'state'), AGENT_SHELL: '/bin/bash' },
    tools: [], skillCatalog: [], settingSources: [], collaboration: false, persistSession: false,
    permissionMode: 'bypassPermissions', systemPrompt: 'Fixture instructions.', thinking: { type: 'disabled' }, maxTurns: 8,
    turnEndChecks: { completion: false, openWork: false }, ...(typeof overrides === 'function' ? overrides(root) : overrides) };
  session = await createSession(options);
  return { root, session, requests, options, send: prompt => collect(session, prompt) };
}

test('a real failed Bash command retains stderr, stdout and its effect without automatic replay', deadline, async t => {
  const f = await fixture(t, (request, count, root) => {
    if (count === 1) return [call('command', 'Bash', {
      command: [process.execPath, join(root, 'command.cjs'), join(root, "包含 空格'文件.txt")].map(quote).join(' '),
      description: 'Run the fixture command.' })];
    assert.equal(count, 2);
    const result = outcome(request, 'command');
    assert.equal(result.is_error, true);
    assert.match(result.content, /code 7/);
    assert.match(result.content, /fixture stdout/);
    assert.match(result.content, /fixture stderr/);
    return [text('The command failed with exit code 7. Its output was retained.')];
  }, { tools: ['Bash'] });
  await writeFile(join(f.root, 'command.cjs'), "require('node:fs').appendFileSync(process.argv[2], 'once\\n'); process.stdout.write('fixture stdout\\n'); process.stderr.write('fixture stderr\\n'); process.exit(7);\n");
  const { result, events } = await f.send();
  assert.equal(result.is_error, false);
  assert.equal(f.requests.length, 2);
  assert.equal(await readFile(join(f.root, "包含 空格'文件.txt"), 'utf8'), 'once\n');
  assert.equal(events.filter(event => event.type === 'user' && event.message.content?.some?.(block => block.tool_use_id === 'command')).length, 1);
});

test('a missing pinned skill never falls back and reads repaired and changed source bodies in the same session', deadline, async t => {
  const f = await fixture(t, async (request, count, root) => {
    const source = join(root, 'SKILL.md');
    if (count === 1) return [call('missing', 'Skill', { skill: 'commit', args: 'target $ARGUMENTS' })];
    if (count === 2) {
      assert.equal(outcome(request, 'missing').is_error, true);
      await writeFile(source, '---\nname: commit\n---\nFIRST_BODY $ARGUMENTS\n');
      return [call('repaired', 'Skill', { skill: 'commit', args: 'target $ARGUMENTS' })];
    }
    if (count === 3) {
      const result = outcome(request, 'repaired');
      assert.notEqual(result.is_error, true);
      assert.match(result.content, /FIRST_BODY target \$ARGUMENTS/);
      await writeFile(source, '---\nname: commit\n---\nLATEST_BODY $ARGUMENTS\n');
      return [call('changed', 'Skill', { skill: 'commit', args: 'latest' })];
    }
    if (count === 4) {
      const result = outcome(request, 'changed');
      assert.notEqual(result.is_error, true);
      assert.match(result.content, /LATEST_BODY latest/);
      assert.ok(!result.content.includes('FIRST_BODY'));
      return [call('artifact', 'Write', { file_path: join(root, 'artifact.txt'), content: 'used-latest-skill' })];
    }
    assert.equal(count, 5);
    assert.notEqual(outcome(request, 'artifact').is_error, true);
    return [text('Loaded the repaired skill and used its latest body.')];
  }, root => ({ tools: ['Skill', 'Write'], skillCatalog: [{ name: 'commit', description: 'Pinned fixture skill',
    source: { kind: 'file', path: join(root, 'SKILL.md') } }] }));
  const { result } = await f.send();
  assert.equal(result.is_error, false);
  assert.equal(f.requests.length, 5);
  assert.equal(await readFile(join(f.root, 'artifact.txt'), 'utf8'), 'used-latest-skill');
});

test('waiting for permission in one session does not block another and a denial never writes', deadline, async t => {
  let ready, release;
  const waiting = new Promise(resolve => { ready = resolve; });
  const decision = new Promise(resolve => { release = resolve; });
  const deny = () => release({ behavior: 'deny', message: 'Fixture permission declined.' });
  t.after(deny);
  t.signal.addEventListener('abort', () => { ready(); deny(); }, { once: true });
  const first = await fixture(t, (request, count, root) => {
    if (count === 1) return [call('denied', 'Write', { file_path: join(root, 'must-not-exist.txt'), content: 'forbidden' })];
    assert.equal(count, 2);
    assert.equal(outcome(request, 'denied').is_error, true);
    return [text('Permission was declined; no write was performed.')];
  }, { tools: ['Write'], permissionMode: 'default', canUseTool: async () => { ready(); return decision; } });
  const second = await fixture(t, (request, count, root) => {
    if (count === 1) return [call('read', 'Read', { file_path: join(root, 'seed.txt') })];
    assert.equal(count, 2);
    assert.match(outcome(request, 'read').content, /SECOND_SESSION_SEED/);
    return [text('The second session completed independently.')];
  }, { tools: ['Read'] });
  await writeFile(join(second.root, 'seed.txt'), 'SECOND_SESSION_SEED');
  let settled = false;
  const pending = first.send().then(value => { settled = true; return value; });
  await waiting;
  t.signal.throwIfAborted();
  assert.equal(settled, false);
  const independent = await second.send();
  assert.equal(independent.result.is_error, false);
  assert.equal(settled, false);
  deny();
  assert.equal((await pending).result.is_error, false);
  await assert.rejects(access(join(first.root, 'must-not-exist.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(join(second.root, 'seed.txt'), 'utf8'), 'SECOND_SESSION_SEED');
});

test('approved parameter changes reach the real file tool before execution', deadline, async t => {
  const f = await fixture(t, (request, count, root) => {
    if (count === 1) return [call('read', 'Read', { file_path: join(root, 'original.txt') })];
    assert.equal(count, 2);
    const result = outcome(request, 'read');
    assert.match(result.content, /APPROVED_FILE/);
    assert.ok(!result.content.includes('ORIGINAL_FILE'));
    return [text('Read the approved file.')];
  }, root => ({ tools: ['Read'], permissionMode: 'default', canUseTool: async (_name, input) => ({
    behavior: 'allow', updatedInput: { ...input, file_path: join(root, 'approved.txt') } }) }));
  await writeFile(join(f.root, 'original.txt'), 'ORIGINAL_FILE');
  await writeFile(join(f.root, 'approved.txt'), 'APPROVED_FILE');
  assert.equal((await f.send()).result.is_error, false);
});

test('an external MCP response lost after its effect is not replayed on recovery or resume', deadline, async t => {
  let effects = 0, deletions = 0, file;
  const peer = await createModelServer(async (request, response, message) => {
    if (request.method === 'DELETE') { deletions++; response.writeHead(204); response.end(); return; }
    if (!message || !Object.hasOwn(message, 'id')) { response.writeHead(204); response.end(); return; }
    let result;
    if (message.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
    else if (message.method === 'tools/list') result = { tools: [{ name: 'append', description: 'Append a fixture record.', inputSchema: { type: 'object' } }] };
    else {
      assert.equal(message.method, 'tools/call');
      assert.equal(message.params.name, 'append');
      effects++;
      await appendFile(file, 'once\n');
      if (effects === 1) { response.destroy(); return; }
      result = { content: [{ type: 'text', text: 'Appended.' }] };
    }
    response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  let f, resumed;
  try {
    f = await fixture(t, (request, count, root) => {
      if (count === 1) return [call('append', 'mcp__records__append')];
      assert.equal(effects, 1);
      assert.equal(outcome(request, 'append').is_error, true);
      if (count === 2) return [call('verify', 'Read', { file_path: join(root, 'effects.txt') })];
      assert.match(outcome(request, 'verify').content, /once/);
      return [text('The recorded effect exists. No action was repeated.')];
    }, { tools: ['Read'], persistSession: true, mcpServers: { records: { type: 'http', url: `${peer.url}/mcp` } } });
    file = join(f.root, 'effects.txt');
    assert.equal((await f.send()).result.is_error, false);
    assert.equal(effects, 1);
    assert.equal(await readFile(file, 'utf8'), 'once\n');
    const id = f.session.sessionId;
    await f.session[Symbol.asyncDispose]();
    resumed = await createSession({ ...f.options, resume: id, strictResume: true });
    assert.equal((await collect(resumed, 'Review the recorded outcome.')).result.is_error, false);
    assert.equal(effects, 1);
    assert.equal(await readFile(file, 'utf8'), 'once\n');
    assert.equal(f.requests.length, 4);
    await resumed[Symbol.asyncDispose]();
    assert.equal(deletions, 2);
  } finally {
    await resumed?.[Symbol.asyncDispose]();
    await f?.session[Symbol.asyncDispose]();
    await peer.close();
  }
});

for (const kind of ['invalid-name', 'relative-source']) test(`invalid ${kind} skill configuration fails before any model request`, deadline, async t => {
  const root = await mkdtemp(join(tmpdir(), 'halo-invalid-skill-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [];
  await assert.rejects(createSession({ model: 'fixture', provider: provider(() => [text('Unexpected.')], requests), cwd: root,
    env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'state') }, collaboration: false, persistSession: false,
    systemPrompt: 'Fixture instructions.', settingSources: [], tools: ['Skill'],
    skillCatalog: [{ name: kind === 'invalid-name' ? '../invalid' : 'fixture', description: 'Fixture',
      source: { kind: 'file', path: kind === 'relative-source' ? 'relative/SKILL.md' : join(root, 'SKILL.md') } }] }), /skill|catalog|absolute/i);
  assert.equal(requests.length, 0);
});

for (const [label, options] of [
  ['zero', { contextWindow: 0, maxOutputTokens: 0 }],
  ['negative', { contextWindow: -1, maxOutputTokens: -1 }],
  ['non-finite', { contextWindow: NaN, maxOutputTokens: Infinity }],
]) test(`${label} window and output settings retain bounded existing defaults`, deadline, async t => {
  const f = await fixture(t, (request, count) => {
    assert.equal(count, 1);
    assert.ok(Number.isFinite(request.maxTokens) && request.maxTokens > 0);
    return [text('Used a bounded request.')];
  }, options);
  const { result } = await f.send();
  assert.equal(result.is_error, false);
  assert.equal(f.requests.length, 1);
  const window = result.modelUsage.fixture.contextWindow;
  assert.ok(Number.isFinite(window) && window > 0);
  assert.ok(f.requests[0].maxTokens <= window);
});

for (const [label, options, subtype] of [
  ['turn', { maxTurns: 0 }, 'error_max_turns'],
  ['cost', { maxBudgetUsd: 0 }, 'error_max_budget_usd'],
]) test(`a zero ${label} budget refuses work before a model request`, deadline, async t => {
  const f = await fixture(t, () => { assert.fail('The model must not start after the budget is exhausted'); }, options);
  const { result } = await f.send();
  assert.equal(result.is_error, true);
  assert.equal(result.subtype, subtype);
  assert.equal(f.requests.length, 0);
  assert.equal(result.usage.input_tokens, 0);
  assert.equal(result.usage.output_tokens, 0);
});

for (const stage of ['before-tool', 'after-effect']) test(`a real ${stage} journal failure preserves execution truth and valid recovery links`, deadline, async t => {
  let f, journal, saved, effects = 0;
  const breakJournal = async () => {
    saved = `${journal}.saved`;
    await rename(journal, saved);
    await mkdir(journal);
  };
  const restore = async () => {
    if (!saved) return;
    await rm(journal, { recursive: true, force: true });
    await rename(saved, journal);
    saved = undefined;
  };
  try {
    f = await fixture(t, async (request, count) => {
      if (count === 1) {
        if (stage === 'before-tool') await breakJournal();
        return [call('fault-effect', 'AppendFixture')];
      }
      assert.equal(effects, stage === 'after-effect' ? 1 : 0);
      if (stage === 'after-effect') {
        const result = outcome(request, 'fault-effect');
        assert.ok(result);
        if (count === 2) assert.equal(result.content, 'Saved before journal failure.');
        else { assert.equal(result.is_error, true); assert.match(result.content, /unknown|not recorded|no recorded/i); }
      }
      return [text('Reviewed the retained state without repeating an action.')];
    }, root => ({ persistSession: true, customTools: [{ name: 'AppendFixture', description: 'Append one fixture record.',
      inputSchema: { type: 'object' }, permissionLevel: 'write', async execute() {
        effects++;
        await appendFile(join(root, 'effects.txt'), 'once\n');
        await breakJournal();
        return { content: 'Saved before journal failure.' };
      } }] }));
    journal = join(f.root, 'state', 'projects', f.root.replace(/[^a-zA-Z0-9]/g, '-'), `${f.session.sessionId}.jsonl`);
    const failed = await f.send();
    assert.equal(failed.result.is_error, true);
    assert.equal(f.requests.length, 1);
    assert.equal(effects, stage === 'after-effect' ? 1 : 0);
    const results = failed.events.flatMap(event => event.type === 'user' && Array.isArray(event.message.content) ? event.message.content : [])
      .filter(block => block.type === 'tool_result' && block.tool_use_id === 'fault-effect');
    if (stage === 'after-effect') {
      assert.match(failed.result.result, /could not be saved to conversation history/);
      assert.equal(results.length, 1);
      assert.equal(results[0].content, 'Saved before journal failure.');
      assert.notEqual(results[0].is_error, true);
      assert.equal(await readFile(join(f.root, 'effects.txt'), 'utf8'), 'once\n');
    } else await assert.rejects(access(join(f.root, 'effects.txt')), { code: 'ENOENT' });
    await restore();
    assert.equal((await f.send('Storage is repaired. Review the current state.')).result.is_error, false);
    await f.session[Symbol.asyncDispose]();
    const records = (await readFile(journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const durable = new Set();
    for (const record of records) {
      if (record.parentUuid) assert.ok(durable.has(record.parentUuid), 'A failed append must not become a later parent');
      if (['user', 'assistant'].includes(record.type)) durable.add(record.uuid);
    }
    const resumed = await createSession({ ...f.options, resume: f.session.sessionId, strictResume: true });
    try { assert.equal((await collect(resumed, 'Inspect the saved state without repeating actions.')).result.is_error, false); }
    finally { await resumed[Symbol.asyncDispose](); }
    assert.equal(f.requests.length, 3);
    assert.equal(effects, stage === 'after-effect' ? 1 : 0);
  } finally { await restore(); }
});

test('a failed result batch retains business effects without granting uncommitted MCP discoveries', deadline, async t => {
  let f, journal, saved, writes = 0, lookups = 0;
  const target = 'mcp__records__lookup';
  const restore = async () => {
    if (!saved) return;
    await rm(journal, { recursive: true, force: true });
    await rename(saved, journal);
    saved = undefined;
  };
  try {
    f = await fixture(t, (request, count) => {
      if (count === 1) return [call('search', 'ToolSearch', { query: `select:${target}` }), call('business', 'AppendFixture')];
      assert.equal(writes, 1);
      assert.equal(outcome(request, 'business').content, 'Business effect recorded.');
      const search = outcome(request, 'search');
      assert.equal(search.is_error, true);
      assert.match(search.content, /No new tool access was granted/);
      assert.ok(!search.content.includes('arguments_schema'));
      if (count === 2) return [call('not-granted', 'CallTool', { tool: target, arguments: {} })];
      if (count === 3) {
        assert.equal(lookups, 0);
        assert.equal(outcome(request, 'not-granted').is_error, true);
        return [call('fresh-search', 'ToolSearch', { query: `select:${target}` })];
      }
      if (count === 4) {
        assert.match(outcome(request, 'fresh-search').content, /arguments_schema/);
        return [call('granted', 'CallTool', { tool: target, arguments: {} })];
      }
      assert.equal(count, 5);
      assert.equal(lookups, 1);
      assert.equal(outcome(request, 'granted').content, 'Lookup verified.');
      return [text('The business effect was retained and only the committed discovery was used.')];
    }, root => ({ persistSession: true,
      mcpServers: { records: { type: 'sdk', name: 'records', instance: {
        listTools: () => [{ name: 'lookup', description: 'Read a fixture record.', inputSchema: { type: 'object' } }],
        async callTool() { lookups++; return { content: [{ type: 'text', text: 'Lookup verified.' }] }; },
      } } }, toolDiscovery: { services: { records: { identity: 'fixture-records', loading: 'deferred' } } },
      customTools: [{ name: 'AppendFixture', description: 'Append a fixture record.', permissionLevel: 'write', inputSchema: { type: 'object' },
        async execute() {
          writes++;
          await appendFile(join(root, 'effects.txt'), 'once\n');
          saved = `${journal}.saved`;
          await rename(journal, saved);
          await mkdir(journal);
          return { content: 'Business effect recorded.' };
        } }] }));
    journal = join(f.root, 'state', 'projects', f.root.replace(/[^a-zA-Z0-9]/g, '-'), `${f.session.sessionId}.jsonl`);
    const first = await f.send();
    assert.equal(first.result.is_error, true);
    assert.equal(writes, 1);
    assert.equal(lookups, 0);
    await restore();
    assert.equal((await f.send('Storage is available again. Continue without repeating the business effect.')).result.is_error, false);
    assert.equal(writes, 1);
    assert.equal(lookups, 1);
    assert.equal(await readFile(join(f.root, 'effects.txt'), 'utf8'), 'once\n');
    assert.equal(f.requests.length, 5);
  } finally { await restore(); }
});
