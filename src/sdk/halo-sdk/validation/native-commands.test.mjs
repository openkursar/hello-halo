import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const { createSession } = await import(pathToFileURL(join(compiled, 'native/session.js')).href);
const { query } = await import(pathToFileURL(join(compiled, 'native/query.js')).href);
const { readSessionToolContextMode } = await import(pathToFileURL(join(compiled, 'native/session-tool-context.js')).href);
const capabilities = () => ({ streaming: true, toolCalling: true, thinking: true, imageInput: true, pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' });
const deferred = () => { let resolve; const promise = new Promise(receipt => { resolve = receipt; }); return { promise, resolve }; };
function fixtureProvider(script) {
  const requests = [];
  return { id: 'commands-fixture', name: 'Commands fixture', capabilities, requests,
    async createMessage() { throw new Error('Unexpected summary request'); },
    async *createMessageStream(request) {
      requests.push(structuredClone({ ...request, providerOptions: undefined }));
      const reply = await script(request, requests.length);
      const blocks = Array.isArray(reply) ? reply : [reply];
      yield { type: 'message_start', id: `command-${requests.length}`, model: request.model, usage: { input_tokens: 10, output_tokens: 0 } };
      for (const [index, block] of blocks.entries()) {
        yield { type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : block };
        if (block.type === 'text') yield { type: 'text_delta', index, text: block.text };
        yield { type: 'content_block_stop', index };
      }
      yield { type: 'message_delta', stopReason: blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { output_tokens: 2 } };
      yield { type: 'message_stop' };
    },
  };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'halo-native-commands-'));
  const cwd = join(root, 'workspace'); await mkdir(cwd);
  const options = { model: 'model-a', fallbackModel: 'fallback', cwd, env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'state') }, persistSession: false,
    collaboration: false, systemPrompt: 'Fixture system', tools: [], skillCatalog: [], thinking: { type: 'disabled' }, turnEndChecks: { openWork: false } };
  return { root, cwd, options, close: () => rm(root, { recursive: true, force: true }) };
}
async function collect(stream) { const events = []; for await (const event of stream) events.push(event); return events; }
async function send(session, text) { await session.send(text); return collect(session.stream()); }
function result(events) { return events.findLast(event => event.type === 'result'); }
function sequence(events) { return events.map(event => event.type === 'system' ? `${event.subtype}${event.state ? `:${event.state}` : ''}` : event.type); }

// These cases call the compiled native binding, including callbacks that await the owning actor.
test('native session commands skip work requests and leave empty history unchanged', { timeout: 15000 }, async () => {
  const f = await fixture(); let session;
  const model = fixtureProvider(async () => { throw new Error('Local command reached provider'); });
  const prompts = [];
  try {
    session = await createSession({ ...f.options, provider: model, hooks: { UserPromptSubmit: [{ hooks: [input => { prompts.push(input.prompt); return {}; }] }] } });
    const supported = await session.query.supportedCommands();
    assert.ok(supported.some(command => command.name === 'help'));
    assert.ok(supported.some(command => command.name === 'compact'));
    const init = await session.command('initializationResult');
    assert.deepEqual(init.commands, supported);
    assert.deepEqual(init.models.map(model => model.value), ['model-a', 'fallback']);
    assert.deepEqual(init.accountInfo, { apiKeySource: 'user' });
    const help = await send(session, '/help');
    assert.deepEqual(sequence(help), ['session_state_changed:running', 'init', 'local_command_output', 'result', 'session_state_changed:idle']);
    assert.equal(result(help).num_turns, 0);
    assert.match(result(help).result, /Available commands/);
    const switched = await send(session, '/model model-b');
    assert.equal(switched.find(event => event.subtype === 'init').model, 'model-b');
    assert.match(result(switched).result, /`model-a` → `model-b`/);
    assert.deepEqual((await session.query.supportedModels()).map(model => model.value), ['model-b', 'fallback']);
    const compact = await send(session, '/compact');
    assert.equal(result(compact).is_error, false);
    assert.match(result(compact).result, /kept unchanged/);
    assert.equal(compact.some(event => event.subtype === 'compact_boundary'), false);
    assert.deepEqual(await session.command('readHistory'), []);
    assert.deepEqual(prompts, ['/help', '/model model-b', '/compact']);
    assert.equal(model.requests.length, 0);
  } finally { await session?.[Symbol.asyncDispose](); await f.close(); }
});

test('a session that only ran a local command resumes strictly like a new session', { timeout: 15000 }, async () => {
  const f = await fixture(); let session;
  let effects = 0;
  const records = {
    mcpServers: { records: { type: 'sdk', name: 'records', instance: {
      listTools: () => [{ name: 'lookup', description: 'Read a fixture record.', inputSchema: { type: 'object' } }],
      async callTool() { effects++; return { content: [{ type: 'text', text: 'Verified fixture record.' }] }; },
    } } },
    toolDiscovery: { services: { records: { identity: 'command-records', loading: 'deferred', summary: 'Read fixture records' } } },
  };
  const options = { ...f.options, ...records, persistSession: true };
  try {
    const local = fixtureProvider(async () => { throw new Error('Local command reached provider'); });
    session = await createSession({ ...options, provider: local });
    const compact = await send(session, '/compact');
    assert.match(result(compact).result, /kept unchanged/);
    const id = session.sessionId;
    assert.equal(result(compact).session_id, id);
    assert.equal(local.requests.length, 0);
    await session[Symbol.asyncDispose](); session = undefined;
    assert.equal(await readSessionToolContextMode(id, { cwd: f.cwd, env: f.options.env }), 'deferred');

    const next = fixtureProvider(async (_request, step) => {
      if (step === 1) return { type: 'tool_use', id: 'search', name: 'ToolSearch', input: { query: 'select:mcp__records__lookup' } };
      if (step === 2) return { type: 'tool_use', id: 'lookup', name: 'CallTool', input: { tool: 'mcp__records__lookup', arguments: {} } };
      return { type: 'text', text: 'Read after resuming.' };
    });
    session = await createSession({ ...options, provider: next, resume: id, strictResume: true });
    assert.equal(session.sessionId, id);
    assert.deepEqual(await session.command('readHistory'), []);
    const events = await send(session, 'Read the fixture record.');
    assert.equal(result(events).is_error, false, JSON.stringify(result(events)));
    assert.equal(effects, 1);
    const sent = JSON.stringify(next.requests[0].messages);
    assert.ok(sent.includes('Read the fixture record.'), sent);
    assert.ok(!sent.includes('/compact') && !sent.includes('kept unchanged'), sent);
  } finally { await session?.[Symbol.asyncDispose](); await f.close(); }
});

test('native custom local commands await clearMessages and allow whole-file replacement after clearing', { timeout: 15000 }, async () => {
  const f = await fixture(); let session;
  const file = join(f.cwd, 'effect.txt');
  const model = fixtureProvider(async (_request, step) => {
    if (step === 1) return { type: 'tool_use', id: 'create', name: 'Write', input: { file_path: file, content: 'before' } };
    if (step === 3) return { type: 'tool_use', id: 'replace', name: 'Write', input: { file_path: file, content: 'after' } };
    return { type: 'text', text: 'finished' };
  });
  try {
    session = await createSession({ ...f.options, provider: model, tools: ['Read', 'Write'], permissionMode: 'bypassPermissions', slashCommands: [{ type: 'local', name: 'reset-fixture', description: 'Clear fixture state', async call(args, context) {
      assert.equal(args, 'now'); assert.equal(context.sessionId, session.sessionId);
      assert.ok(context.messages.some(message => JSON.stringify(message).includes('seed turn')));
      assert.ok(context.getCostSnapshot().tokens.input > 0);
      await context.clearMessages();
      context.setModel('after-clear');
      return { kind: 'system', markdown: 'cleared by callback' };
    } }] });
    await send(session, 'seed turn');
    const cleared = await send(session, '/reset-fixture now');
    assert.equal(result(cleared).result, 'cleared by callback');
    assert.equal(cleared.find(event => event.subtype === 'init').model, 'after-clear');
    assert.deepEqual(await session.command('readHistory'), []);
    const events = await send(session, 'after clear');
    assert.equal(result(events).is_error, false);
    assert.equal(model.requests[2].model, 'after-clear');
    assert.ok(!JSON.stringify(model.requests[2].messages).includes('seed turn'));
    const replacement = model.requests[3].messages.flatMap(message => Array.isArray(message.content) ? message.content : []).find(block => block.tool_use_id === 'replace');
    assert.ok(replacement);
    assert.equal(Boolean(replacement.is_error), false);
    assert.equal(await readFile(file, 'utf8'), 'after');
    const usage = await send(session, '/usage');
    assert.match(result(usage).result, /\*\*Turns:\*\* 2/);
    assert.match(result(usage).result, /\*\*Total tokens:\*\* 48/);
  } finally { await session?.[Symbol.asyncDispose](); await f.close(); }
});

test('native clear checkpoints a fresh deferred-tool baseline and resume cannot reuse cleared access', { timeout: 15000 }, async () => {
  const f = await fixture(); let session; let resumed; let effects = 0;
  const record = { name: 'mcp__records__record', description: 'Record a fixture value', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    permissionLevel: 'none', mcpSource: { server: 'records', name: 'record', toolDescription: 'Record a fixture value' },
    execute: async () => { effects++; return { content: 'recorded fixture', isError: false }; } };
  const options = { ...f.options, persistSession: true, customTools: [record], toolDiscovery: { services: { records: { identity: 'fixture:records', loading: 'deferred', summary: 'Record fixture values' } } } };
  const model = fixtureProvider(async (_request, step) => step === 1
    ? { type: 'tool_use', id: 'search', name: 'ToolSearch', input: { query: 'select:mcp__records__record' } }
    : step === 2 || step === 4 ? { type: 'tool_use', id: `record-${step}`, name: 'CallTool', input: { tool: 'mcp__records__record', arguments: JSON.stringify({ value: step === 2 ? 'before clear' : 'after rejected clear' }) } }
      : { type: 'text', text: 'access granted' });
  try {
    session = await createSession({ ...options, provider: model });
    const discovered = await send(session, 'discover and record');
    assert.equal(effects, 1, JSON.stringify(result(discovered)));
    const transcript = join(f.options.env.CLAUDE_CONFIG_DIR, 'projects', f.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${session.sessionId}.jsonl`);
    await session.flush();
    const original = await readFile(transcript, 'utf8');
    await rm(transcript); await mkdir(transcript);
    const refused = await send(session, '/clear');
    assert.equal(result(refused).is_error, true, 'A failed checkpoint cannot clear live history');
    assert.match(result(refused).result, /Error running \/clear/);
    assert.ok(JSON.stringify(await session.command('readHistory')).includes('discover and record'));
    await rm(transcript, { recursive: true }); await writeFile(transcript, original);
    await send(session, 'verify access after the refused clear');
    assert.equal(effects, 2, 'The refused reset must preserve the previously granted tool definition');
    const clear = await send(session, '/clear');
    assert.equal(result(clear).is_error, false, result(clear).result);
    const history = await session.command('readHistory');
    assert.equal(history.length, 1);
    assert.deepEqual(history[0].toolContext.baseline.definitions, []);
    assert.ok(!JSON.stringify(history).includes('discover and record'));
    const id = session.sessionId;
    await session[Symbol.asyncDispose](); session = undefined;
    const next = fixtureProvider(async (_request, step) => step === 1
      ? { type: 'tool_use', id: 'stale', name: 'CallTool', input: { tool: 'mcp__records__record', arguments: JSON.stringify({ value: 'must not execute' }) } }
      : { type: 'text', text: 'cleared access refused' });
    resumed = await createSession({ ...options, provider: next, resume: id, strictResume: true });
    await send(resumed, 'check cleared access');
    assert.equal(effects, 2);
    assert.ok(!JSON.stringify(next.requests[0].messages).includes('discover and record'));
    const denial = next.requests[1].messages.flatMap(message => Array.isArray(message.content) ? message.content : []).find(block => block.tool_use_id === 'stale');
    assert.equal(denial.is_error, true);
  } finally { await session?.[Symbol.asyncDispose](); await resumed?.[Symbol.asyncDispose](); await f.close(); }
});

test('native prompt commands expand skills and preserve multimodal session replacements', { timeout: 15000 }, async () => {
  const f = await fixture(); let session;
  const skill = join(f.cwd, 'SKILL.md'); await writeFile(skill, 'Instructions for $ARGUMENTS');
  const model = fixtureProvider(async () => ({ type: 'text', text: 'expanded' }));
  try {
    session = await createSession({ ...f.options, provider: model, tools: ['Skill'], skillCatalog: [{ name: 'fixture-skill', description: 'Fixture skill', source: { kind: 'file', path: skill } }],
      slashCommands: [{ type: 'prompt', name: 'fixture-prompt', description: 'Fixture prompt', async getPromptForCommand(args) { return [{ role: 'assistant', content: 'ignored assistant' }, { role: 'user', content: [{ type: 'text', text: `replaced ${args}` }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } }] }]; } }] });
    await send(session, '/fixture-skill target');
    assert.ok(JSON.stringify(model.requests[0].messages).includes('Instructions for target'));
    assert.ok(!JSON.stringify(model.requests[0].messages).includes('/fixture-skill target'));
    await send(session, '/fixture-prompt input');
    const blocks = model.requests[1].messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
    assert.ok(blocks.some(block => block.type === 'image' && block.source.data === 'aGk='));
    assert.ok(blocks.some(block => block.type === 'text' && block.text === 'replaced input'));
    assert.ok(!JSON.stringify(model.requests[1].messages).includes('ignored assistant'));
  } finally { await session?.[Symbol.asyncDispose](); await f.close(); }
});

test('native controls acknowledge during a blocked provider while resident sessions retain their stream configuration', { timeout: 15000 }, async () => {
  const f = await fixture(); let session; const started = deferred(); const release = deferred();
  const model = fixtureProvider(async (_request, step) => {
    if (step === 1) { started.resolve(); await release.promise; return { type: 'tool_use', id: 'probe', name: 'Probe', input: {} }; }
    return { type: 'text', text: 'controlled' };
  });
  try {
    session = await createSession({ ...f.options, provider: model, thinking: { type: 'enabled', budgetTokens: 500 }, customTools: [{ name: 'Probe', description: 'Fixture probe', inputSchema: { type: 'object', properties: {} }, permissionLevel: 'none', execute: async () => ({ content: 'probe', isError: false }) }] });
    await session.send('start'); const stream = collect(session.stream()); await started.promise;
    await Promise.all([session.setModel('model-b'), session.setPermissionMode('bypassPermissions'), session.setMaxThinkingTokens(null), session.query.setMcpServers({}), session.query.stopTask('absent')]);
    release.resolve(); await stream;
    assert.deepEqual(model.requests.slice(0, 2).map(request => request.model), ['model-a', 'model-a']);
    assert.equal(model.requests[1].thinking.type, 'enabled');
    const next = await send(session, 'next stream');
    assert.equal(model.requests[2].model, 'model-b');
    assert.equal(model.requests[2].thinking.type, 'disabled');
    assert.equal(next.find(event => event.subtype === 'init').permissionMode, 'bypassPermissions');
    await session.setModel(undefined);
    assert.equal((await session.query.supportedModels())[0].value, 'model-a');
  } finally { release.resolve(); await session?.[Symbol.asyncDispose](); await f.close(); }
});

test('native query controls apply at model boundaries and local commands retain one-shot events', { timeout: 15000 }, async () => {
  const f = await fixture(); const started = deferred(); const release = deferred(); let active;
  const model = fixtureProvider(async (_request, step) => {
    if (step === 1) { started.resolve(); await release.promise; return { type: 'tool_use', id: 'probe', name: 'Probe', input: {} }; }
    return { type: 'text', text: 'query controlled' };
  });
  try {
    active = query({ prompt: 'start query', options: { ...f.options, provider: model, thinking: { type: 'enabled', budgetTokens: 500 }, customTools: [{ name: 'Probe', description: 'Fixture probe', inputSchema: { type: 'object', properties: {} }, permissionLevel: 'none', execute: async () => ({ content: 'probe', isError: false }) }] } });
    const stream = collect(active); await started.promise;
    await Promise.all([active.setModel('model-b'), active.setMaxThinkingTokens(null), active.setPermissionMode('bypassPermissions')]);
    assert.deepEqual((await active.supportedModels()).map(model => model.value), ['model-a', 'fallback']);
    release.resolve(); const events = await stream; active = undefined;
    assert.deepEqual(model.requests.map(request => request.model), ['model-a', 'model-b']);
    assert.equal(model.requests[1].thinking.type, 'disabled');
    assert.ok(events.every(event => event.subtype !== 'session_state_changed'));
    const localModel = fixtureProvider(async () => { throw new Error('Query local command reached provider'); });
    const local = await collect(query({ prompt: '/help', options: { ...f.options, provider: localModel } }));
    assert.deepEqual(sequence(local), ['local_command_output', 'result']);
    const compact = await collect(query({ prompt: '/compact', options: { ...f.options, provider: localModel } }));
    assert.equal(result(compact).is_error, false);
    assert.match(result(compact).result, /kept unchanged/);
    assert.equal(localModel.requests.length, 0);
  } finally { release.resolve(); await active?.return(); await f.close(); }
});

test('batched and live slash text remains ordinary model input', { timeout: 15000 }, async () => {
  const f = await fixture(); let session; const started = deferred(); const release = deferred();
  const model = fixtureProvider(async (_request, step) => { if (step === 2) { started.resolve(); await release.promise; } return { type: 'text', text: 'ordinary input' }; });
  try {
    session = await createSession({ ...f.options, provider: model });
    await session.send('/help'); await session.send('batched');
    const batch = await collect(session.stream());
    assert.ok(!batch.some(event => event.subtype === 'local_command_output'));
    assert.ok(JSON.stringify(model.requests[0].messages).includes('/help'));
    await session.send('live turn'); const live = collect(session.stream()); await started.promise;
    assert.equal(session.sendIntoLiveTurn('/help'), true);
    release.resolve(); const events = await live;
    assert.ok(!events.some(event => event.subtype === 'local_command_output'));
    assert.equal(model.requests.length, 3);
    assert.ok(JSON.stringify(model.requests[2].messages).includes('/help'));
  } finally { release.resolve(); await session?.[Symbol.asyncDispose](); await f.close(); }
});


async function seedForManualCompact(f, model, extra = {}) {
  const session = await createSession({ ...f.options, persistSession: true, provider: model, ...extra });
  for (let index = 0; index < 4; index++) {
    const events = await send(session, `Evidence turn ${index}. ${'original observation '.repeat(700)}`);
    assert.equal(result(events).is_error, false);
  }
  await send(session, 'LATEST_CONSTRAINT: report only and do not repeat completed actions.');
  return session;
}

test('manual compaction uses the existing summary request and durable recovery without a work turn', { timeout: 15000 }, async () => {
  const f = await fixture(); let session;
  let effects = 0;
  const model = fixtureProvider(async (_request, step) => {
    if (step === 1) return { type: 'tool_use', id: 'manual-search', name: 'ToolSearch', input: { query: 'select:mcp__records__lookup' } };
    if (step === 2) return { type: 'tool_use', id: 'manual-before', name: 'CallTool', input: { tool: 'mcp__records__lookup', arguments: {} } };
    return { type: 'text', text: 'Recorded evidence. '.repeat(300) };
  });
  const mcp = {
    mcpServers: { records: { type: 'sdk', name: 'records', instance: {
      listTools: () => [{ name: 'lookup', description: 'Read a fixture record.', inputSchema: { type: 'object' } }],
      async callTool() { effects++; await writeFile(join(f.cwd, 'lookup-count'), String(effects)); return { content: [{ type: 'text', text: 'Verified fixture record.' }] }; },
    } } },
    toolDiscovery: { services: { records: { identity: 'manual-records', loading: 'deferred', summary: 'Read fixture records' } } },
  };
  const summaries = [], hooks = [];
  model.createMessage = async request => {
    summaries.push(request);
    assert.deepEqual(request.systemPrompt, model.requests.at(-1).systemPrompt);
    assert.deepEqual(request.tools, model.requests.at(-1).tools);
    assert.ok(request.messages.some(message => JSON.stringify(message).includes('LATEST_CONSTRAINT')));
    assert.match(request.messages.at(-1).content, /retain verified facts/);
    assert.ok(!request.messages.some(message => message.content === '/compact retain verified facts'));
    return { id: 'manual-summary', model: request.model, stopReason: 'end_turn',
      content: [{ type: 'text', text: '<summary>MANUAL_HANDOVER: verified evidence and the latest constraints.</summary>' }],
      usage: { input_tokens: 23, output_tokens: 7 } };
  };
  try {
    session = await seedForManualCompact(f, model, { ...mcp, hooks: {
      PreCompact: [{ hooks: [input => { hooks.push(input); return {}; }] }],
      PostCompact: [{ hooks: [input => { hooks.push(input); return {}; }] }],
    } });
    const before = await session.command('captureCheckpoint');
    const workRequests = model.requests.length;
    const events = await send(session, '/compact retain verified facts');
    assert.equal(result(events).is_error, false, JSON.stringify(result(events)));
    assert.equal(result(events).num_turns, 0);
    assert.equal(result(events).usage.input_tokens, 23);
    assert.equal(result(events).usage.output_tokens, 7);
    assert.match(result(events).result, /context compacted/);
    assert.equal(model.requests.length, workRequests);
    assert.equal(summaries.length, 1);
    assert.equal(effects, 1);
    const boundary = events.find(event => event.subtype === 'compact_boundary');
    assert.equal(boundary.compact_metadata.trigger, 'manual');
    assert.match(boundary.summary, /MANUAL_HANDOVER/);
    assert.equal(hooks.length, 2);
    assert.ok(hooks.every(input => input.trigger === 'manual'));
    assert.equal(hooks[0].custom_instructions, 'retain verified facts');
    const after = await session.command('captureCheckpoint');
    assert.equal(after.costs.tokens.input, before.costs.tokens.input + 23);
    assert.equal(after.costs.tokens.output, before.costs.tokens.output + 7);
    const history = await session.command('readHistory');
    assert.match(JSON.stringify(history), /MANUAL_HANDOVER/);
    assert.match(JSON.stringify(history), /LATEST_CONSTRAINT/);
    assert.ok(!history.some(message => message.content === '/compact retain verified facts'));
    const id = session.sessionId;
    await session[Symbol.asyncDispose]();
    const next = fixtureProvider(async (request, step) => {
      assert.match(JSON.stringify(request.messages), /MANUAL_HANDOVER/);
      assert.match(JSON.stringify(request.messages), /LATEST_CONSTRAINT/);
      if (step === 1) {
        assert.equal(effects, 1);
        return { type: 'tool_use', id: 'manual-after', name: 'CallTool', input: { tool: 'mcp__records__lookup', arguments: {} } };
      }
      return { type: 'text', text: 'Continued from the committed summary.' };
    });
    session = await createSession({ ...f.options, ...mcp, persistSession: true, provider: next, resume: id, strictResume: true });
    assert.equal(result(await send(session, 'Continue with the retained constraint.')).is_error, false);
    assert.equal(next.requests.length, 2);
    assert.equal(effects, 2);
    assert.equal(await readFile(join(f.cwd, 'lookup-count'), 'utf8'), '2');
  } finally { await session?.[Symbol.asyncDispose](); await f.close(); }
});

for (const failure of ['summary', 'cancel', 'checkpoint']) test(`manual compaction preserves the session after ${failure} failure`, { timeout: 15000 }, async () => {
  const f = await fixture(); let session; let path, saved; const started = deferred();
  const model = fixtureProvider(async () => ({ type: 'text', text: 'Verified historical observation. '.repeat(250) }));
  model.createMessage = async request => {
    if (failure === 'summary') throw new Error('Fixture summary unavailable');
    if (failure === 'cancel') {
      started.resolve();
      await new Promise(resolve => {
        const signal = request.providerOptions.signal;
        if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true });
      });
      throw Object.assign(new Error('Fixture summary cancelled'), { name: 'AbortError' });
    }
    return { id: 'summary', model: request.model, stopReason: 'end_turn',
      content: [{ type: 'text', text: '<summary>Summary that must not be installed.</summary>' }], usage: { input_tokens: 11, output_tokens: 3 } };
  };
  try {
    session = await seedForManualCompact(f, model);
    const before = await session.command('readHistory');
    if (failure === 'checkpoint') {
      path = join(f.options.env.CLAUDE_CONFIG_DIR, 'projects', f.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${session.sessionId}.jsonl`);
      saved = `${path}.saved`; await rename(path, saved); await mkdir(path);
    }
    const collecting = send(session, '/compact');
    if (failure === 'cancel') { await started.promise; await session.interrupt(); }
    const events = await collecting;
    assert.equal(result(events).is_error, true, JSON.stringify(result(events)));
    assert.equal(events.some(event => event.subtype === 'compact_boundary'), false);
    assert.deepEqual(await session.command('readHistory'), before);
    if (saved) { await rm(path, { recursive: true }); await rename(saved, path); saved = undefined; }
    const recovered = await send(session, 'Continue with the original evidence.');
    assert.equal(result(recovered).is_error, false);
    assert.match(JSON.stringify(model.requests.at(-1).messages), /original observation/);
    assert.ok(!model.requests.at(-1).messages.some(message => message.content === '/compact'));
  } finally {
    if (saved) { await rm(path, { recursive: true, force: true }); await rename(saved, path); }
    await session?.[Symbol.asyncDispose](); await f.close();
  }
});

const unsignedThinking = blocks => blocks.some(block => block.type === 'thinking' && !block.signature);
const summaryBlocks = request => request.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
const missingThinkingSignature = (requestRejected = true) => Object.assign(
  new Error('messages.6.content.0.thinking.signature: Field required'), { statusCode: 400, requestRejected },
);

for (const outcome of ['success', 'rejected', 'stream-error', 'cancel', 'checkpoint']) {
  test(`manual compaction recovers rejected reasoning after resume: ${outcome}`, { timeout: 15000 }, async () => {
    const f = await fixture(); let session; let saved; let path;
    const started = deferred();
    const beforeHooks = [], afterHooks = [], summaries = [];
    const unsigned = { type: 'thinking', thinking: 'Reasoning from the earlier model.' };
    const visibleEvidence = 'Visible evidence from the earlier model.';
    const handover = 'REPAIRED_HANDOVER: Keep the visible evidence and follow the latest constraint.';
    const earlier = fixtureProvider((_request, step) => step === 5 ? unsigned : { type: 'text', text: `${visibleEvidence} ${'Observed facts. '.repeat(190)}` });
    const resumed = fixtureProvider(() => ({ type: 'text', text: 'Continued from the same conversation.' }));
    resumed.createMessage = async request => {
      summaries.push({ ...request, messages: structuredClone(request.messages) });
      if (summaries.length === 1 || outcome === 'rejected') throw missingThinkingSignature(outcome !== 'stream-error');
      if (outcome === 'cancel') {
        started.resolve();
        const signal = request.providerOptions.signal;
        if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        throw Object.assign(new Error('Cancelled repaired summary'), { name: 'AbortError' });
      }
      return { id: 'repaired-summary', model: request.model, stopReason: 'end_turn',
        content: [{ type: 'text', text: handover }], usage: { input_tokens: 29, output_tokens: 13 } };
    };
    const options = { ...f.options, persistSession: true };
    try {
      session = await seedForManualCompact(f, earlier, { model: 'earlier-model' });
      const id = session.sessionId;
      path = join(options.env.CLAUDE_CONFIG_DIR, 'projects', f.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
      await session[Symbol.asyncDispose]();
      const original = await readFile(path, 'utf8');
      session = await createSession({ ...options, model: 'claude-fixture', provider: resumed, resume: id, strictResume: true,
        hooks: { PreCompact: [{ hooks: [input => { beforeHooks.push(input.trigger); return {}; }] }],
          PostCompact: [{ hooks: [input => { afterHooks.push(input.trigger); return {}; }] }] } });
      const before = await session.command('readHistory');
      assert.ok(unsignedThinking(summaryBlocks({ messages: before })));
      if (outcome === 'checkpoint') {
        saved = `${path}.saved`; await rename(path, saved); await mkdir(path);
      }
      const running = send(session, '/compact retain verified facts');
      if (outcome === 'cancel') { await started.promise; await session.interrupt(); }
      const events = await running;
      const terminal = result(events);
      assert.equal(terminal.is_error, outcome !== 'success', terminal.result);
      assert.equal(terminal.num_turns, 0);
      assert.equal(summaries.length, outcome === 'stream-error' ? 1 : 2);
      assert.equal(resumed.requests.length, 0);
      assert.ok(unsignedThinking(summaryBlocks(summaries[0])));
      if (outcome !== 'stream-error') assert.ok(!unsignedThinking(summaryBlocks(summaries[1])));
      for (const request of summaries) {
        assert.match(JSON.stringify(request.messages), /Visible evidence from the earlier model/);
        assert.match(JSON.stringify(request.messages), /LATEST_CONSTRAINT/);
        assert.match(request.messages.at(-1).content, /retain verified facts/);
        assert.equal(request.model, 'claude-fixture');
      }
      assert.deepEqual(beforeHooks, ['manual']);
      const boundaries = events.filter(event => event.subtype === 'compact_boundary');
      const after = await session.command('readHistory');
      if (outcome === 'success') {
        assert.deepEqual(afterHooks, ['manual']);
        assert.equal(boundaries.length, 1);
        assert.match(boundaries[0].summary, /REPAIRED_HANDOVER/);
        assert.equal(terminal.usage.input_tokens, 29);
        assert.equal(terminal.usage.output_tokens, 13);
        assert.ok(!unsignedThinking(summaryBlocks({ messages: after })));
        await session[Symbol.asyncDispose]();
        assert.ok((await readFile(path, 'utf8')).startsWith(original), 'Original transcript records must not be rewritten');
        session = await createSession({ ...options, model: 'claude-fixture', provider: resumed, resume: id, strictResume: true });
      } else {
        assert.deepEqual(afterHooks, []);
        assert.equal(boundaries.length, 0);
        assert.deepEqual(after, before);
        if (saved) { await rm(path, { recursive: true }); await rename(saved, path); saved = undefined; }
        assert.equal(await readFile(path, 'utf8'), original);
      }
      const continuation = result(await send(session, 'Continue without repeating completed work.'));
      assert.equal(continuation.is_error, false, continuation.result);
      assert.equal(resumed.requests.length, 1);
      assert.match(JSON.stringify(resumed.requests[0].messages), /LATEST_CONSTRAINT/);
      assert.equal(unsignedThinking(summaryBlocks(resumed.requests[0])), outcome !== 'success');
    } finally {
      if (saved) { await rm(path, { recursive: true, force: true }); await rename(saved, path); }
      await session?.[Symbol.asyncDispose](); await f.close();
    }
  });
}

test('manual compaction reclaims output space without removing a signed tool exchange', { timeout: 15000 }, async () => {
  const f = await fixture(); let session;
  const signed = { type: 'thinking', thinking: 'Verify the latest decision.', signature: 'recent-provider-signature' };
  const call = { type: 'tool_use', id: 'recent-check', name: 'Check', input: {} };
  const handover = 'Keep the latest constraint and the completed check result.';
  let effects = 0;
  const tool = { name: 'Check', description: 'Verify the fixture value.', inputSchema: { type: 'object', properties: {} },
    permissionLevel: 'none', async execute() { effects++; return { content: 'Verified: amber-218.' }; } };
  const earlier = fixtureProvider((_request, step) => {
    if (step === 1) return [
      { type: 'thinking', thinking: 'Old reasoning. '.repeat(830) },
      { type: 'text', text: 'Original verified evidence.' },
    ];
    return { type: 'text', text: 'Earlier work recorded.' };
  });
  const current = fixtureProvider((_request, step) => {
    if (step === 1) return [signed, call];
    if (step === 2) throw Object.assign(new Error('Fixture stopped before answering the tool result'), { statusCode: 400 });
    return { type: 'text', text: 'Continued without repeating the check.' };
  });
  const budgets = [];
  const pairs = request => summaryBlocks(request).filter(block =>
    block.signature === signed.signature || block.id === call.id || block.tool_use_id === call.id);
  current.createMessage = async request => {
    budgets.push(request.maxTokens);
    if (unsignedThinking(summaryBlocks(request))) throw missingThinkingSignature();
    assert.deepEqual(pairs(request), [signed, call, { type: 'tool_result', tool_use_id: call.id, content: 'Verified: amber-218.' }]);
    return { id: 'summary-with-tool-context', model: request.model,
      stopReason: request.maxTokens < 2000 ? 'max_tokens' : 'end_turn',
      content: [{ type: 'text', text: handover }], usage: { input_tokens: 31, output_tokens: 17 } };
  };
  const options = { ...f.options, persistSession: true, contextWindow: 8100, maxOutputTokens: 3000 };
  const active = { ...options, model: 'claude-fixture', provider: current, customTools: [tool] };
  try {
    session = await createSession({ ...options, contextWindow: 200_000, model: 'earlier-model', provider: earlier });
    for (let index = 0; index < 4; index++) {
      assert.equal(result(await send(session, `Earlier records ${index}. ${'Verified. '.repeat(90)}`)).is_error, false);
    }
    const id = session.sessionId;
    await session[Symbol.asyncDispose]();
    session = await createSession({ ...active, contextWindow: 200_000, resume: id, strictResume: true });
    const interrupted = result(await send(session, 'LATEST_CONSTRAINT: Keep only the verified value.'));
    assert.equal(interrupted.is_error, true);
    assert.match(interrupted.result, /Fixture stopped before answering the tool result/);
    assert.equal(effects, 1);
    await session[Symbol.asyncDispose]();
    session = await createSession({ ...active, resume: id, strictResume: true });
    const events = await send(session, '/compact');
    assert.equal(result(events).is_error, false, result(events).result);
    assert.equal(events.filter(event => event.subtype === 'compact_boundary').length, 1);
    assert.equal(budgets.length, 2);
    assert.ok(budgets[0] >= 1024 && budgets[0] < 2000, JSON.stringify(budgets));
    assert.equal(budgets[1], 3000);
    assert.equal(current.requests.length, 2);
    const checkpoint = await session.command('readHistory');
    assert.deepEqual(pairs({ messages: checkpoint }), [signed, call, { type: 'tool_result', tool_use_id: call.id, content: 'Verified: amber-218.' }]);
    assert.ok(!unsignedThinking(summaryBlocks({ messages: checkpoint })));
    assert.equal(effects, 1);
    await session[Symbol.asyncDispose]();
    session = await createSession({ ...active, resume: id, strictResume: true });
    const continuation = result(await send(session, 'Continue without repeating the check.'));
    assert.equal(continuation.is_error, false, continuation.result);
    assert.equal(effects, 1);
    assert.deepEqual(pairs(current.requests.at(-1)), pairs({ messages: checkpoint }));
    assert.match(JSON.stringify(current.requests.at(-1).messages), /LATEST_CONSTRAINT/);
  } finally { await session?.[Symbol.asyncDispose](); await f.close(); }
});

test('manual summary repairs image input without replacing stored images', { timeout: 15000 }, async () => {
  const f = await fixture(); let session;
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/Fim0AAAAASUVORK5CYII=';
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } };
  const model = fixtureProvider(() => ({ type: 'text', text: 'Evidence recorded.' }));
  const summaries = [];
  model.createMessage = async request => {
    summaries.push(structuredClone(request.messages));
    if (summaries.length === 1) throw Object.assign(new Error('This model does not support image input.'), { statusCode: 400, requestRejected: true });
    return { id: 'image-summary', model: request.model, stopReason: 'end_turn',
      content: [{ type: 'text', text: 'IMAGE_HANDOVER: Keep the latest user evidence.' }], usage: { input_tokens: 23, output_tokens: 9 } };
  };
  try {
    session = await seedForManualCompact(f, model);
    await session.send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Latest evidence is attached.' }, image] } });
    assert.equal(result(await collect(session.stream())).is_error, false);
    const sends = model.requests.length;
    assert.equal(result(await send(session, '/compact')).is_error, false);
    assert.equal(model.requests.length, sends);
    assert.equal(summaries.length, 2);
    assert.ok(JSON.stringify(summaries[0]).includes(png));
    assert.ok(!JSON.stringify(summaries[1]).includes(png));
    assert.match(JSON.stringify(summaries[1]), /Latest evidence is attached/);
    assert.ok(JSON.stringify(await session.command('readHistory')).includes(png));
  } finally { await session?.[Symbol.asyncDispose](); await f.close(); }
});

test('a text-only input envelope invokes compact without sending its slash text to the provider', { timeout: 15000 }, async () => {
  const f = await fixture(); let session;
  const model = fixtureProvider(async () => { throw new Error('Text-only command reached the provider'); });
  try {
    session = await createSession({ ...f.options, provider: model });
    await session.send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '/compact' }] } });
    const events = await collect(session.stream());
    assert.equal(result(events).is_error, false);
    assert.match(result(events).result, /kept unchanged/);
    assert.equal(model.requests.length, 0);
  } finally { await session?.[Symbol.asyncDispose](); await f.close(); }
});


test('a custom native local command awaits the same manual compaction handler', { timeout: 15000 }, async () => {
  const f = await fixture(); let session;
  const model = fixtureProvider(async () => ({ type: 'text', text: 'Historical evidence. '.repeat(400) }));
  let summaries = 0;
  model.createMessage = async request => {
    summaries++; assert.match(request.messages.at(-1).content, /keep current facts/);
    return { id: 'custom-summary', model: request.model, stopReason: 'end_turn',
      content: [{ type: 'text', text: '<summary>Custom command retained the verified history.</summary>' }],
      usage: { input_tokens: 17, output_tokens: 5 } };
  };
  try {
    session = await seedForManualCompact(f, model, { slashCommands: [{ type: 'local', name: 'condense-fixture', description: 'Condense fixture history.',
      async call(args, context) { await context.compactSession(args); return { kind: 'system', markdown: 'Fixture maintenance completed.' }; },
    }] });
    const requests = model.requests.length;
    const events = await send(session, '/condense-fixture keep current facts');
    assert.equal(result(events).is_error, false, JSON.stringify(result(events)));
    assert.equal(result(events).result, 'Fixture maintenance completed.');
    assert.equal(result(events).usage.input_tokens, 17);
    assert.equal(events.find(event => event.subtype === 'compact_boundary').compact_metadata.trigger, 'manual');
    assert.equal(summaries, 1); assert.equal(model.requests.length, requests);
  } finally { await session?.[Symbol.asyncDispose](); await f.close(); }
});
