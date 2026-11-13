import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { MemoryScopeStore } from '../dist/native/collaboration-store.js';
import { createBlackboardWriter } from '../dist/native/collaboration-board.js';
import { openMemberWorkspace, releaseMemberWorkspace, remapWorkspaceDeniedRoots } from '../dist/native/collaboration-workspaces.js';
import { createSdkCollaboration } from '../dist/native/collaboration-sdk.js';
import { loadBinding } from '../dist/native/binding.js';

test('native public store retains failed persistence and board observers cannot roll back a committed write', async () => {
  const batches = [];
  const failure = new Error('journal temporarily unavailable');
  let attempts = 0;
  const store = new MemoryScopeStore({ teamId: 'team', epochId: 'work', maxRecords: 2,
    async persist(mutations) { batches.push(structuredClone(mutations)); if (++attempts === 1) throw failure; },
  });
  store.addMember({ id: 'reader', name: 'reader', parentId: 'lead', prompt: 'read', createdAt: 1, cwd: undefined });
  assert.equal(Object.hasOwn(store.getMember('reader'), 'cwd'), true);
  assert.equal(store.getMember('reader').cwd, undefined);
  await assert.rejects(store.flush(), error => error === failure);
  store.addMember({ id: 'second', name: 'second', parentId: 'lead', prompt: 'work', createdAt: 2 });
  await store.flush();
  assert.deepEqual(batches.map(batch => batch.map(mutation => mutation.value.id)), [['reader'], ['reader', 'second']]);
  assert.throws(() => store.addMember({ id: 'third', name: 'third', parentId: 'lead', prompt: 'overflow', createdAt: 3 }), /record limit/);
  assert.equal(store.members().length, 2);
  assert.throws(() => store.insertTask({ id: 'invalid', teamId: 'team', epochId: 'work', invalid: { __haloSdkNativeUndefined: true } }), /scalar fields/);
  const writes = [];
  const writer = createBlackboardWriter({ store, clock: () => 42.5, createId: () => 'task',
    onChange() { throw new Error('observer failed after commit'); }, onWrite: record => writes.push(record),
  });
  assert.deepEqual(writer.postTask({ teamId: 'team', epochId: 'work', callerAppId: 'lead', title: 'Verify', assigneeAppId: 'reader' }), { taskId: 'task' });
  assert.equal(store.getTaskById('task').createdAt, 42.5);
  assert.equal(writes[0].op, 'post_task');
  assert.throws(() => writer.updateTask({ teamId: 'other', epochId: 'work', taskId: 'task', status: 'done' }), /not in this collaboration/);
  assert.equal(store.getTaskById('task').status, 'pending');
  await store.flush();
});

test('native public workspace validates real authorized directories and remaps denied ancestors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'halo-native-workspace-'));
  const outside = await mkdtemp(join(tmpdir(), 'halo-native-outside-'));
  try {
    const signal = new AbortController().signal;
    const workspace = await openMemberWorkspace({ member: { id: 'reader' }, parentCwd: root, signal });
    assert.equal(workspace.cwd.endsWith(root.split('/').at(-1)), true);
    await symlink(outside, join(root, 'outside'));
    await assert.rejects(openMemberWorkspace({ member: { id: 'reader', cwd: join(root, 'outside') }, parentCwd: root, signal }), /outside the authorized workspace/);
    assert.deepEqual(remapWorkspaceDeniedRoots(['/repo/private'], { cwd: '/checkout', gitRoot: '/repo', checkout: '/checkout' }), ['/repo/private', '/checkout/private']);
    await releaseMemberWorkspace(workspace);
  } finally { await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]); }
});

test('standalone native collaboration factory creates only children and resumes their retired history', { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'halo-native-public-collaboration-'));
  const output = join(directory, 'evidence.txt');
  const delivered = [];
  let starts = 0;
  let calls = 0;
  const provider = {
    id: 'public-collaboration-fixture', name: 'Public collaboration fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false, pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { throw new Error('Unexpected completion request'); },
    async *createMessageStream(request) {
      const step = ++calls;
      const serialized = JSON.stringify(request.messages);
      let block;
      if (step === 1) block = { type: 'tool_use', id: 'write-evidence', name: 'Write', input: { file_path: output, content: 'standalone native collaboration' } };
      else if (step === 2) {
        assert.equal(await readFile(output, 'utf8'), 'standalone native collaboration');
        block = { type: 'tool_use', id: 'reply', name: 'mcp__halo-team__team_send', input: { to: 'lead', message: 'The standalone child wrote evidence.txt.' } };
      } else {
        assert.ok(serialized.includes('write-evidence'));
        if (step === 4) assert.ok(serialized.includes('Continue from your retained history.'));
        block = { type: 'text', text: '' };
      }
      yield { type: 'message_start', id: `child-${step}`, model: request.model, usage: { input_tokens: 20, output_tokens: 0 } };
      yield { type: 'content_block_start', index: 0, content_block: block };
      if (block.type === 'text') yield { type: 'text_delta', index: 0, text: 'Evidence retained.' };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: block.type === 'tool_use' ? 'tool_use' : 'end_turn', usage: { output_tokens: 5 } };
      yield { type: 'message_stop' };
    },
  };
  const options = { model: 'local-fixture', provider, cwd: directory, env: { HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'state') },
    permissionMode: 'bypassPermissions', systemPrompt: 'Standalone child fixture.', thinking: { type: 'disabled' }, persistSession: false,
    tools: ['Write', 'spawn_agent'], hooks: { SessionStart: [{ hooks: [async () => { starts++; return {}; }] }] },
  };
  const binding = createSdkCollaboration({ sessionId: 'public-source', getOptions: () => options,
    settings: { maxConcurrentTurns: 2, maxMembers: 2, maxIdleSessions: 0 },
    async deliverToSource(envelope) { delivered.push(envelope); return 'buffered'; },
  });
  t.signal.addEventListener('abort', () => { void binding.close(); }, { once: true });
  const idle = async () => { for (let attempt = 0; attempt < 1000 && binding.activeCount > 0; attempt++) await delay(5); assert.equal(binding.activeCount, 0); };
  try {
    assert.equal(JSON.parse(loadBinding().runtimeDiagnostics()).activeSessions, 0);
    const created = await binding.server.instance.callTool('spawn_agent', { name: 'reader', prompt: 'Write evidence.txt, reply to lead, then finish.' });
    assert.notEqual(created.isError, true, JSON.stringify(created));
    await idle();
    assert.equal(calls, 3);
    assert.equal(starts, 1);
    assert.equal(binding.residentCount, 0);
    assert.equal(binding.retainedCount, 1);
    assert.ok(delivered.some(envelope => envelope.body.includes('The standalone child wrote evidence.txt.')));
    const continued = await binding.server.instance.callTool('team_send', { to: 'reader', message: 'Continue from your retained history.' });
    assert.notEqual(continued.isError, true, JSON.stringify(continued));
    await idle();
    assert.equal(calls, 4);
    assert.equal(starts, 2);
    assert.equal(binding.retainedCount, 1);
    assert.ok(Object.keys(binding.drainUsage()).length > 0);
    assert.deepEqual(binding.drainUsage(), {});
  } finally {
    await binding.close();
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(JSON.parse(loadBinding().runtimeDiagnostics()).activeSessions, 0);
});

test('accepted native collaborator inputs are observed across repeated live-to-idle boundaries', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'halo-native-live-boundary-'));
  const observed = new Set();
  let firstRequest;
  const started = new Promise(resolve => { firstRequest = resolve; });
  let turn = 0;
  const provider = {
    id: 'live-boundary-fixture', name: 'Live boundary fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false, pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { throw new Error('Unexpected completion request'); },
    async *createMessageStream(request) {
      for (const match of JSON.stringify(request.messages).matchAll(/packet:(\d+)/g)) observed.add(Number(match[1]));
      firstRequest();
      const id = `live-${++turn}`;
      yield { type: 'message_start', id, model: request.model, usage: { input_tokens: 1, output_tokens: 0 } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'text_delta', index: 0, text: 'Input observed.' };
      await delay(1);
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: 'end_turn', usage: { output_tokens: 1 } };
      yield { type: 'message_stop' };
    },
  };
  const binding = createSdkCollaboration({ sessionId: 'live-source',
    getOptions: () => ({ model: 'fixture', provider, cwd: directory, persistSession: false,
      permissionMode: 'bypassPermissions', tools: ['spawn_agent'], systemPrompt: 'Live admission fixture.', thinking: { type: 'disabled' } }),
    async deliverToSource() { return 'buffered'; },
  });
  try {
    const created = await binding.server.instance.callTool('spawn_agent', { name: 'reader', prompt: 'packet:0' });
    assert.notEqual(created.isError, true);
    await started;
    await Promise.all(Array.from({ length: 40 }, async (_, index) => {
      await delay(index % 5);
      const response = await binding.server.instance.callTool('team_send', { to: 'reader', message: `packet:${index + 1}` });
      assert.notEqual(response.isError, true, JSON.stringify(response));
    }));
    for (let attempt = 0; attempt < 1000 && (binding.activeCount > 0 || observed.size < 41); attempt++) await delay(5);
    assert.deepEqual([...observed].sort((a, b) => a - b), Array.from({ length: 41 }, (_, index) => index));
    assert.equal(binding.activeCount, 0);
  } finally { await binding.close(); await rm(directory, { recursive: true, force: true }); }
});
