import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildWorker } from '../../../../scripts/build-worker.mjs';
import { createWorkerRuntime, type WorkerRuntime, type WorkerSession } from '../../worker/index.js';
import type { HookCallbackMatcher } from '../../types/config.js';

let buildDirectory: string;
const roots: string[] = [];
const runtimes: WorkerRuntime[] = [];
beforeAll(async () => {
  buildDirectory = await mkdtemp(join(tmpdir(), 'compaction-context-worker-build-'));
  await buildWorker(join(buildDirectory, 'entry.mjs'));
});
afterAll(async () => { await rm(buildDirectory, { recursive: true, force: true }); });
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function turn(session: WorkerSession, input: string) {
  await session.send(input);
  const events = [];
  for await (const event of session.stream()) { events.push(event); if (event.type === 'result') break; }
  expect(events.at(-1)).toMatchObject({ is_error: false });
  return events;
}
async function fixture(matcher: HookCallbackMatcher) {
  const root = await mkdtemp(join(tmpdir(), 'compaction-context-worker-'));
  roots.push(root);
  const requests = join(root, 'requests.jsonl');
  const runtime = createWorkerRuntime({ workerUrl: pathToFileURL(join(buildDirectory, 'entry.mjs')),
    maxWorkers: 1, warmWorkers: 0, startupTimeoutMs: 5000, closeTimeoutMs: 5000 });
  runtimes.push(runtime);
  const session = await runtime.createSession({ model: 'fixture', cwd: root, tools: [], skillCatalog: [],
    env: { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: join(root, 'state') },
    persistSession: false, settingSources: [], systemPrompt: 'Stable worker instructions.',
    turnEndChecks: { openWork: false, completion: false }, collaboration: { mode: 'hosted' },
    hooks: { PreCompact: [matcher] },
  }, { setup: { module: new URL('../../worker/fixtures/tool-context.mjs', import.meta.url).href,
    data: { requests, replies: [] } } });
  return { session, requests };
}

describe('PreCompact additionalContext through the worker callback boundary', () => {
  it('calls the host hook only for compaction and carries its text into the next request', async () => {
    const hook = vi.fn(async () => ({ additionalContext: 'Members (1): original-worker (idle).' }));
    const { session, requests } = await fixture({ hooks: [hook] });
    await turn(session, 'Earlier evidence. '.repeat(2000));
    await turn(session, 'Retain the current task.');
    expect(hook).not.toHaveBeenCalled();
    const events = await turn(session, '/compact');
    expect(events.some(event => event.type === 'system' && event.subtype === 'compact_boundary')).toBe(true);
    expect(hook).toHaveBeenCalledOnce();
    await turn(session, 'Continue with the original collaborator.');
    const records = (await readFile(requests, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const last = JSON.stringify(records.at(-1));
    expect(last).toContain('<system-reminder>\\nMembers (1): original-worker (idle).\\n</system-reminder>');
    expect(last).not.toContain('compactionContext');
    expect(records.filter(record => record.summary)).toHaveLength(1);
  });

  it('times out a slow hook without cancelling compaction or the worker session', async () => {
    let hookSignal: AbortSignal | undefined;
    const { session, requests } = await fixture({ timeout: 1, hooks: [async (_input, _id, { signal }) => new Promise((_resolve, reject) => {
      hookSignal = signal;
      signal.addEventListener('abort', () => reject(new Error('Hook cancelled')), { once: true });
    })] });
    await turn(session, 'Earlier evidence. '.repeat(2000));
    await turn(session, 'Retain the current task.');
    const events = await turn(session, '/compact');
    expect(events.some(event => event.type === 'system' && event.subtype === 'compact_boundary')).toBe(true);
    expect(hookSignal?.aborted).toBe(true);
    await turn(session, 'Continue after the hook timeout.');
    const records = (await readFile(requests, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(JSON.stringify(records.at(-1))).not.toContain('Hook cancelled');
  }, 15_000);
});
