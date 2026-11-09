import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { buildWorker } from '../scripts/build-worker.mjs';
import { createWorkerRuntime, isResumeHistoryError, type WorkerRuntime } from './index.js';
import { getTranscriptPath } from '../core/transcript.js';

let buildDirectory: string;
let directory: string;
let runtime: WorkerRuntime;
beforeAll(async () => {
  buildDirectory = await mkdtemp(join(tmpdir(), 'mode-reader-worker-build-'));
  await buildWorker(join(buildDirectory, 'entry.mjs'));
});
afterAll(async () => { await rm(buildDirectory, { recursive: true, force: true }); });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mode-reader-worker-'));
  runtime = createWorkerRuntime({ workerUrl: pathToFileURL(join(buildDirectory, 'entry.mjs')),
    maxWorkers: 1, warmWorkers: 1, startupTimeoutMs: 5000, closeTimeoutMs: 5000 });
});
afterEach(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });

async function history(name: string, mode: 'full' | 'deferred', large = false) {
  const options = { cwd: directory, env: { CLAUDE_CONFIG_DIR: join(directory, name) } };
  const path = getTranscriptPath('same-session', directory, options);
  await mkdir(dirname(path), { recursive: true });
  const message = { role: 'user', content: large ? 'Evidence. '.repeat(1_200_000) : 'Ordinary first request.',
    ...(mode === 'deferred' ? { toolContext: { version: 1, baselineAttachment: false,
      baseline: { version: 1, discoveryEntries: false, generation: 'fixture', directory: '', definitions: [] } } } : {}) };
  const record = large ? { type: 'compact_checkpoint', checkpointVersion: 2, uuid: 'checkpoint',
    summary: 'Synthetic retained evidence.', messages: [message] }
    : { type: 'user', uuid: 'first', message };
  await writeFile(path, JSON.stringify(record) + '\n');
  return { options, path };
}
function assertReleased(pool: WorkerRuntime) {
  const state = pool.diagnostics();
  expect(state.fileLocks).toBe(0);
  expect(state.transcriptLocks).toBe(0);
  for (const worker of state.workers) {
    expect(worker).toMatchObject({ sessions: 0, active: 0, pendingRpc: 0, callbacks: 0, children: 0, pendingInputs: 0, bufferedEvents: 0 });
  }
}
async function whenReserved() {
  for (let i = 0; i < 1000; i++) {
    if (runtime.diagnostics().workers.some(worker => worker.sessions > 0)) return;
    await delay(1);
  }
  throw new Error('Inspection did not reserve a worker');
}

describe('pooled session tool-context inspection', () => {
  it('uses one prewarmed worker and keeps callers with the same session ID isolated by their paths', async () => {
    const [full, deferred] = await Promise.all([history('legacy', 'full'), history('native', 'deferred')]);
    await runtime.initialize();
    const before = runtime.diagnostics().workers[0].threadId;
    const original = await readFile(deferred.path, 'utf8');
    expect(await Promise.all([
      runtime.readSessionToolContextMode('same-session', full.options),
      runtime.readSessionToolContextMode('same-session', deferred.options),
    ])).toEqual(['full', 'deferred']);
    expect(runtime.diagnostics().workers.map(worker => worker.threadId)).toEqual([before]);
    expect(await readFile(deferred.path, 'utf8')).toBe(original);
    assertReleased(runtime);
  });

  it('returns typed history errors, releases the reservation and leaves the worker reusable', async () => {
    const good = await history('native', 'deferred');
    await runtime.initialize();
    const threadId = runtime.diagnostics().workers[0].threadId;
    const error = await runtime.readSessionToolContextMode('missing', good.options).catch(error => error);
    expect(isResumeHistoryError(error)).toBe(true);
    expect(error.reason).toBe('missing');
    assertReleased(runtime);
    await expect(runtime.readSessionToolContextMode('same-session', { ...good.options, resumeSessionAt: 'unknown' }))
      .rejects.toMatchObject({ reason: 'incomplete' });
    assertReleased(runtime);
    expect(await runtime.readSessionToolContextMode('same-session', good.options)).toBe('deferred');
    expect(runtime.diagnostics().workers.map(worker => worker.threadId)).toEqual([threadId]);
  });

  it('keeps host timers running while validating a large compact checkpoint', async () => {
    const large = await history('large', 'deferred', true);
    await runtime.initialize();
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    try {
      expect(await runtime.readSessionToolContextMode('same-session', large.options)).toBe('deferred');
      expect(ticks).toBeGreaterThan(2);
    } finally { clearInterval(timer); }
    assertReleased(runtime);
  });

  it('cancels a reserved read and frees it before the next inspection', async () => {
    const large = await history('large', 'deferred', true);
    await runtime.initialize();
    const controller = new AbortController();
    const reading = runtime.readSessionToolContextMode('same-session', large.options, { signal: controller.signal });
    const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    await whenReserved();
    controller.abort();
    await rejected;
    assertReleased(runtime);
    expect(await runtime.readSessionToolContextMode('same-session', large.options)).toBe('deferred');
    assertReleased(runtime);
  });

  it('does not start a worker for an already-cancelled inspection', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(runtime.readSessionToolContextMode('same-session', { cwd: directory }, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(runtime.diagnostics().workers).toEqual([]);
  });

  it('settles a read and releases all resources when runtime shutdown races it', async () => {
    const large = await history('large', 'deferred', true);
    await runtime.initialize();
    const reading = runtime.readSessionToolContextMode('same-session', large.options);
    const settled = reading.then(() => 'completed', () => 'cancelled');
    await whenReserved();
    await runtime.close();
    expect(['completed', 'cancelled']).toContain(await settled);
    expect(runtime.diagnostics()).toMatchObject({ closed: true, workers: [], fileLocks: 0, transcriptLocks: 0 });
  });
});

it('releases an inspection reservation when its worker exits unexpectedly', async () => {
  await runtime.close();
  const entry = join(directory, 'exit-during-inspection.mjs');
  await writeFile(entry, `import { parentPort, workerData } from 'node:worker_threads';
    parentPort.on('message', frame => {
      if (frame.type === 'request' && frame.method === 'readSessionToolContextMode') process.exit(19);
    });
    parentPort.postMessage({ type: 'event', event: 'ready', value: { protocolVersion: workerData.protocolVersion } });
  `);
  runtime = createWorkerRuntime({ workerUrl: pathToFileURL(entry), maxWorkers: 1, startupTimeoutMs: 1000, closeTimeoutMs: 1000 });
  await expect(runtime.readSessionToolContextMode('session', { cwd: directory })).rejects.toThrow('exited unexpectedly');
  expect(runtime.diagnostics()).toMatchObject({ workers: [], fileLocks: 0, transcriptLocks: 0, recentFailures: 1 });
});
