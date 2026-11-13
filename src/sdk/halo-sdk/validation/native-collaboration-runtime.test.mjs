import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createMessageBus, TeamBusError } from '../dist/native/message-bus.js';
import { CollaborationRuntime } from '../dist/native/collaboration-runtime.js';
import { MemoryScopeStore } from '../dist/native/collaboration-store.js';
import { CollaborationRefusal } from '../dist/native/collaboration-contract.js';
import { loadBinding } from '../dist/native/binding.js';

test('public native message bus preserves local admission, fenced recipients and remote completion receipts', { timeout: 10_000 }, async () => {
  const members = [ { appId: 'a', memberName: 'alice', origin: 'local' }, { appId: 'b', memberName: 'bee', origin: 'local' }, { appId: 'r', memberName: 'remote', origin: 'remote', ownerNodeId: 'other' } ];
  const wakes = [];
  const records = [];
  let acquisitions = 0;
  let remoteCompletion;
  let bus;
  bus = createMessageBus({
    store: {
      getMember: (_team, id) => members.find(member => member.appId === id) ?? null,
      getMemberByName: (_team, name) => members.find(member => member.memberName === name) ?? null,
      listMembersByTeam: () => members,
      isEdgeAllowed: () => true,
      getTeamById: () => ({ leadAppId: 'a' }), getEpochById: () => ({ endedAt: null }),
    },
    hooks: {
      isBusy() { bus.getEpochStats('work'); return false; },
      acquireRecipientFence() { acquisitions++; return 'current'; },
      acceptRecipientFence: (_target, fence) => fence === 'current',
      async wakeTarget(request) { wakes.push(request); },
      deliverRemote(request) { remoteCompletion = request.onCompletion; return true; },
    },
    recordActivity: record => records.push(record), syncWaitTimeoutMs: 500,
  });
  assert.equal(bus.resolveMemberAppId('team', 'lead', 'work'), 'a');
  const first = bus.send({ teamId: 'team', epochId: 'work', fromAppId: 'a', to: 'bee', message: 'One local assignment.' });
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].trigger.recipientFence, 'current');
  assert.equal(acquisitions, 1);
  const accepted = await first;
  assert.equal(typeof accepted.messageId, 'string');
  bus.completeTurn({ sessionKey: wakes[0].sessionKey, trigger: wakes[0].trigger, outcome: { kind: 'result', content: 'This is a completion, not a directed reply.' } });
  assert.equal(wakes.length, 1);
  assert.equal(records.filter(record => record.kind === 'reply').length, 0);
  const human = bus.send({ teamId: 'team', epochId: 'work', fromAppId: null, to: 'bee', message: 'Human receipt.', wait: true });
  for (let attempt = 0; attempt < 100 && wakes.length < 2; attempt++) await delay(2);
  assert.equal(wakes.length, 2);
  bus.completeTurn({ sessionKey: wakes[1].sessionKey, trigger: wakes[1].trigger, outcome: { kind: 'result', content: 'Human work completed.' } });
  assert.deepEqual(await human, { from: 'bee', message: 'Human work completed.', status: 'ok' });
  const remote = bus.send({ teamId: 'team', epochId: 'work', fromAppId: 'a', to: 'remote', message: 'Remote work.', wait: true });
  for (let attempt = 0; attempt < 100 && !remoteCompletion; attempt++) await delay(2);
  assert.equal(typeof remoteCompletion, 'function');
  remoteCompletion({ kind: 'undelivered', reason: 'Remote owner unavailable.' });
  assert.deepEqual(await remote, { from: 'remote', message: 'This message was not delivered (the teammate is offline or unreachable).', status: 'undelivered' });
  const count = acquisitions;
  await assert.rejects(bus.deliverRuntimeWake({ envelope: { ...wakes[0].envelope, recipientFence: 'expired' }, trigger: { ...wakes[0].trigger, recipientFence: 'expired' }, onBusy: 'buffer' }), TeamBusError);
  assert.equal(acquisitions, count);
  bus.resetEpoch('work');
  assert.equal(bus.hasBufferedMessages('work'), false);
});

test('public native collaboration runtime owns nested admission, live input and scoped board writes through a host executor', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'halo-native-runtime-'));
  const file = join(directory, 'host-evidence.txt');
  const store = new MemoryScopeStore({ teamId: 'team', epochId: 'work' });
  const tracked = Object.create(store);
  let taskInserts = 0;
  let taskUpdates = 0;
  tracked.insertTask = task => { taskInserts++; store.insertTask(task); };
  tracked.updateTask = (id, patch, now) => { taskUpdates++; store.updateTask(id, patch, now); };
  let finishFirst;
  let nestedCreated;
  const release = new Promise(resolve => { finishFirst = resolve; });
  const nested = new Promise(resolve => { nestedCreated = resolve; });
  const requests = [];
  const live = [];
  const notices = [];
  const released = [];
  let changes = 0;
  let runtime;
  runtime = new CollaborationRuntime({ store: tracked, maxConcurrentTurns: 1, maxMembers: 2,
    onChange() { changes++; if (runtime) assert.ok(runtime.activeCount >= 0); },
    async deliverToSource(envelope) { notices.push(envelope); return 'buffered'; },
    executor: {
      async execute(request) {
        assert.ok(store.getMember(request.member.id));
        requests.push(request);
        request.ready();
        if (request.member.name === 'reader') {
          await writeFile(file, 'actual host executor evidence');
          const result = await request.server.instance.callTool('spawn_agent', { name: 'reviewer', prompt: 'Inspect the actual evidence.' });
          assert.notEqual(result.isError, true, JSON.stringify(result));
          nestedCreated();
          await release;
        } else assert.equal(await readFile(file, 'utf8'), 'actual host executor evidence');
        return { kind: 'result', content: `${request.member.name} finished.` };
      },
      inject(_member, deliveries) { live.push(...deliveries); return true; },
      async interrupt() { finishFirst(); return true; },
      async release(member) { released.push(member); },
      async readMember() { return 'Host-owned record.'; },
      async readArtifact() { return readFile(file, 'utf8'); },
      async validateArtifact(ref) { return ref; },
    },
  });
  try {
    assert.equal(JSON.parse(loadBinding().runtimeDiagnostics()).activeSessions, 0);
    assert.equal(await runtime.spawn(runtime.coordinatorId, { name: 'reader', prompt: 'Write an evidence file and delegate review.' }), 'reader');
    await nested;
    assert.equal(requests.length, 1);
    assert.equal(store.members().length, 2);
    const reply = JSON.parse(await runtime.send(runtime.coordinatorId, 'reader', 'Keep the evidence file.'));
    assert.equal(reply.delivery, 'mid_turn');
    assert.equal(live.length, 1);
    assert.equal(live[0].envelope.body, 'Keep the evidence file.');
    const created = await runtime.serverFor().instance.callTool('team_post_task', { title: 'Verify artifact', assignee: 'reviewer' });
    const task = JSON.parse(created.content[0].text).taskId;
    const reviewer = store.findMember('reviewer');
    const updated = await runtime.serverFor(reviewer.id).instance.callTool('team_update_task', { taskId: task, status: 'done', resultRef: 'host-evidence.txt' });
    assert.notEqual(updated.isError, true, JSON.stringify(updated));
    assert.equal(taskInserts, 1); assert.equal(taskUpdates, 1);
    assert.equal(store.getTaskById(task).status, 'done');
    await assert.rejects(runtime.stop(reviewer.id, 'reader'), CollaborationRefusal);
    finishFirst();
    for (let attempt = 0; attempt < 1000 && runtime.activeCount; attempt++) await delay(5);
    assert.equal(runtime.activeCount, 0);
    assert.equal(requests.length, 2);
    assert.equal(notices.length, 2);
    assert.ok(changes > 0);
    assert.equal(await readFile(file, 'utf8'), 'actual host executor evidence');
  } finally {
    finishFirst();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(released.length, 2);
  assert.equal(JSON.parse(loadBinding().runtimeDiagnostics()).activeSessions, 0);
});
