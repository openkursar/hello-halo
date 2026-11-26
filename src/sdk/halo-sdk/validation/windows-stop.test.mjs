import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { classify, outcome, plan, residuals, summarize } from './windows-stop.mjs';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('./windows-stop.mjs', import.meta.url));

test('plans every single and parallel stop before launching a fixture', () => {
  const report = plan(12);
  assert.deepEqual(report.groups.map(({kind, width}) => [kind, width]), [
    ['sleep', 1], ['sleep', 12], ['native-tree', 1], ['native-tree', 12], ['churn', 1], ['churn', 12],
  ]);
  assert.equal(report.groups.flatMap(g => g.samples).length, 39);
  assert.equal(outcome(report), 'incomplete');
  for (const n of [0, 9, 21, 10.5, NaN]) assert.throws(() => plan(n));
});

test('only the explicit foreground cancellation receipt counts as confirmation', () => {
  const result = (isError, content) => ({ isError, content });
  assert.equal(classify(result(true, 'Command exited with code 130\n(No output)'), true), 'cancel-confirmed');
  assert.equal(classify(result(true, 'Command was stopped, but not every process it started could be confirmed stopped. More'), true), 'cancel-unconfirmed');
  for (const text of ['Command exited with code 1', 'Command exited with code 1300', 'Command timed out after 40ms and was terminated.']) {
    assert.equal(classify(result(true, text), true), 'command-error');
  }
  assert.equal(classify(result(true, 'Command exited with code 130'), false), 'command-error');
  assert.equal(classify(result(false, '(No output)'), true), 'command-completed');
  assert.equal(classify(null, true), 'missing-receipt');
  assert.equal(classify({content: 'Command exited with code 130'}, true), 'missing-receipt');
});

test('unregistered launch, failed MSYS mapping, and inconsistent identity remain unknown', () => {
  const members = [
    {key: 'shell', msys: true, pid: 11}, {key: 'sleep', msys: true}, {key: 'new'},
    {key: 'working', pid: 12}, {key: 'finished', naturallyExited: true}, {key: 'conflict', naturallyExited: true},
  ];
  const values = new Map([['shell', 'exited'], ['working', 'running'], ['conflict', 'running']]);
  assert.deepEqual(residuals(members, values), { expectedMembers: 6, boundHandles: 3, exited: 2, running: 1, unknown: 3, msysMapped: 1, msysUnmapped: 1 });
});

test('missing evidence stays incomplete; confirmed-stop contradiction or neighbour failure is a failure', () => {
  const report = plan(10);
  for (const group of report.groups) {
    Object.assign(group, {phase: 'finished', neighbour: 'continued', fixtureRelease: 'released', observer: 'available'});
    for (const sample of group.samples) Object.assign(sample, {ready: true, requested: true, receipt: 'cancel-confirmed', requestToReceiptMs: 5, receiptSinceFirstRequestMs: 7, residuals: {boundHandles: 2, exited: 2, running: 0, unknown: 0}});
  }
  assert.equal(outcome(report), 'measured');
  const group = report.groups[0], s = group.samples[0];
  s.residuals.unknown = 1; assert.equal(outcome(report), 'measured-with-uncertainty');
  s.residuals.running = 1; assert.equal(outcome(report), 'failed');
  s.receipt = 'cancel-unconfirmed'; assert.equal(outcome(report), 'measured-with-uncertainty');
  group.observer = 'unavailable'; assert.equal(outcome(report), 'incomplete');
  group.observer = 'available'; s.residuals.boundHandles = 0; assert.equal(outcome(report), 'incomplete');
  group.neighbour = 'failed'; assert.equal(outcome(report), 'failed');
});

test('one missing stop receipt makes the batch incomplete, unlike an explicit unconfirmed receipt', () => {
  const group = plan(10).groups.find(g => g.width === 10);
  Object.assign(group, { phase: 'finished', neighbour: 'continued', fixtureRelease: 'released', observer: 'available' });
  for (const sample of group.samples) Object.assign(sample, { ready: true, requested: true, receipt: 'cancel-confirmed',
    requestToReceiptMs: 5, receiptSinceFirstRequestMs: 7, residuals: { boundHandles: 1, running: 0, unknown: 0 } });
  const report = { groups: [group] }, last = group.samples.at(-1);
  last.receipt = 'cancel-unconfirmed';
  assert.equal(outcome(report), 'measured-with-uncertainty');
  Object.assign(last, { receipt: 'missing-receipt', requestToReceiptMs: null, receiptSinceFirstRequestMs: null });
  assert.equal(outcome(report), 'incomplete');
  const summary = summarize(group);
  assert.equal(summary.confirmed, 9); assert.equal(summary.unconfirmed, 0); assert.equal(summary.missingReceipt, 1);
  assert.equal(summary.batchWallMs, null);
});

test('rates use only valid stop receipts, batch time requires every receipt, and observation time is excluded', () => {
  const s = (receipt, latency, offset) => ({requested: true, receipt, requestToReceiptMs: latency, receiptSinceFirstRequestMs: offset, observationLagMs: 1000});
  const group = {width: 3, samples: [s('cancel-confirmed', 20, 23), s('cancel-unconfirmed', 40, 40), s('missing-receipt', null, null)]};
  let stats = summarize(group);
  assert.equal(stats.batchWallMs, null); assert.equal(stats.rateDenominator, 2); assert.equal(stats.unconfirmedRate, 0.5);
  assert.equal(stats.missingReceipt, 1); assert.equal(stats.invalidStopResults, 0);
  assert.deepEqual(stats.validStopLatencyMs, {count: 2, min: 20, p50: 20, p95: 40, max: 40});
  group.samples[2] = s('command-error', 10, 47);
  stats = summarize(group);
  assert.equal(stats.batchWallMs, 47); assert.equal(stats.rateDenominator, 2); assert.equal(stats.invalidStopResults, 1);
  stats = summarize(plan(12).groups[1]);
  assert.equal(stats.unconfirmedRate, null); assert.equal(stats.notRequested, 12); assert.equal(stats.batchWallMs, null);
});

test('a rejected configuration still writes clean UTF-8 JSON without machine or environment details', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stop-report-test-'));
  const output = join(dir, 'report.json');
  try {
    await assert.rejects(exec(process.execPath, [script, '--output', output, '--concurrency', '1'], {
      env: {...process.env, MEASURE_TEST_PRIVATE: 'fixture-must-not-appear'},
    }), {code: 2, stdout: '', stderr: ''});
    const bytes = await readFile(output);
    const raw = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    assert.equal(JSON.parse(raw).outcome, 'incomplete');
    assert(!raw.includes(dir)); assert(!raw.includes('fixture-must-not-appear'));
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('unsupported hosts write the complete planned matrix and do not launch Windows tools', {skip: process.platform === 'win32'}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stop-platform-test-'));
  try {
    const output = join(dir, 'report.json');
    await assert.rejects(exec(process.execPath, [script, '--output', output]), {code: 2, stdout: '', stderr: ''});
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.reason, 'windows-required'); assert.equal(report.outcome, 'incomplete');
    assert.equal(report.groups.flatMap(g => g.samples).filter(s => !s.requested && s.requestToReceiptMs === null).length, 39);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
