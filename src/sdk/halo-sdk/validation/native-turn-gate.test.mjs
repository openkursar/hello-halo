import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createTurnGate, TurnGateCapacityError } from '../dist/native/turn-gate.js';
import { loadBinding } from '../dist/native/binding.js';

test('native turn admission preserves arbitrary job references and synchronous callback ordering', { timeout: 10_000 }, async () => {
  const value = { value: 1n, callback() {} };
  value.self = value;
  let gate;
  const dispatched = [];
  gate = createTurnGate({
    isBusy(key) { assert.equal(gate.bufferedCount(key), 0); return false; },
    dispatch(key, job) { dispatched.push([key, job]); return Promise.resolve(); },
  });
  const delivery = gate.deliver('chat', value);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0][1], value);
  assert.equal(await delivery, 'dispatched');
  gate.release('chat');
  const result = { circular: value };
  let ran = false;
  const exclusive = gate.runExclusive('chat', () => { ran = true; return Promise.resolve(result); });
  assert.equal(ran, true);
  assert.equal(await exclusive, result);
  assert.equal(gate.isOccupied('chat'), false);
  assert.equal(JSON.parse(loadBinding().runtimeDiagnostics()).activeSessions, 0);
});

test('native mailbox retains unknown permissions, capacity and exclusive barriers', { timeout: 10_000 }, async () => {
  let busy = true;
  const received = [];
  const discarded = [];
  const gate = createTurnGate({
    isBusy: () => busy,
    getJobIdentity: job => job.identity,
    getActiveIdentity: () => 'owner',
    mergeJobs: jobs => ({ identity: 'owner', batch: jobs }),
    deliverMidTurn(_key, job) { received.push(job); return true; },
    async dispatch(_key, job) { received.push(job); },
  }, { bufferCap: 3, onDiscard: (job, reason) => discarded.push([job, reason]), recheckMs: 5 });
  const unknown = { body: 'unknown' };
  assert.equal(await gate.deliver('chat', unknown), 'buffered');
  assert.equal(await gate.deliver('chat', { identity: 'owner', body: 'live' }), 'mid_turn');
  let exclusiveRan = false;
  const exclusive = gate.runExclusive('chat', async () => { exclusiveRan = true; return 'barrier'; });
  const behind = { identity: 'owner', body: 'behind barrier' };
  assert.equal(await gate.deliver('chat', behind), 'buffered');
  await assert.rejects(gate.deliver('chat', { body: 'overflow' }), TurnGateCapacityError);
  assert.deepEqual(gate.bufferedJobs('chat'), [unknown, behind]);
  assert.equal(exclusiveRan, false);
  busy = false;
  gate.release('chat'); gate.drain('chat');
  assert.equal(received.at(-1), unknown);
  await delay(5);
  gate.release('chat'); gate.drain('chat');
  assert.equal(await exclusive, 'barrier');
  await delay(5);
  assert.equal(received.at(-1), behind);
  gate.release('chat');
  assert.equal(discarded.length, 0);
});

test('native deferred recheck invokes JavaScript callbacks and callback errors preserve ownership', { timeout: 10_000 }, async () => {
  let busy = true;
  const received = [];
  const failure = new Error('identity unavailable');
  const gate = createTurnGate({
    isBusy: () => busy,
    getJobIdentity(job) { if (job.invalid) throw failure; return job.identity; },
    async dispatch(_key, job) { received.push(job); },
  }, { recheckMs: 5 });
  await assert.rejects(gate.deliver('chat', { invalid: true }), error => error === failure);
  assert.equal(gate.bufferedCount('chat'), 0);
  const queued = { body: 'wait for idle' };
  assert.equal(await gate.deliver('chat', queued), 'buffered');
  busy = false;
  for (let attempt = 0; attempt < 200 && received.length === 0; attempt++) await delay(5);
  assert.deepEqual(received, [queued]);
  gate.release('chat');
  assert.equal(gate.bufferedCount('chat'), 0);
});
