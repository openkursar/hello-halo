import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createWorkerRuntime, type WorkerRuntime } from './index.js';
import type { Options } from '../index.js';
import { buildWorker } from '../scripts/build-worker.mjs';

let buildDirectory: string;
let directory: string;
let runtime: WorkerRuntime;

beforeAll(async () => {
  buildDirectory = await mkdtemp(join(tmpdir(), 'sdk-skill-worker-build-'));
  await buildWorker(join(buildDirectory, 'entry.mjs'));
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sdk-skill-worker-'));
  await mkdir(join(directory, '.agents', 'skills'), { recursive: true });
  await writeFile(join(directory, '.agents', 'skills', 'commit.md'), 'LOCAL_COMMIT_BODY');
  await writeFile(join(directory, 'foreign.md'), 'FOREIGN_COMMIT_BODY');
  runtime = createWorkerRuntime({ workerUrl: pathToFileURL(join(buildDirectory, 'entry.mjs')),
    warmWorkers: 1, maxWorkers: 1, startupTimeoutMs: 5000, closeTimeoutMs: 5000 });
});
afterEach(async () => {
  await runtime.close();
  await rm(directory, { recursive: true, force: true });
});
afterAll(async () => { await rm(buildDirectory, { recursive: true, force: true }); });

function options(): Options {
  return {
    model: 'fixture', apiKey: 'fixture', cwd: directory,
    env: { HOME: join(directory, 'home'), USERPROFILE: join(directory, 'home'), CLAUDE_CONFIG_DIR: join(directory, 'state') },
    conventions: { agentDirs: ['.agents'], memoryFiles: [], memorySubdirs: [] },
    persistSession: false, tools: ['spawn_agent', 'Skill'], permissionMode: 'bypassPermissions',
    turnEndChecks: { openWork: false, completion: false },
    skillCatalog: [{ name: 'commit', description: 'Explicit foreign workflow',
      source: { kind: 'file', path: join(directory, 'foreign.md') } }],
  };
}

async function results(path: string, collaborator: boolean) {
  const requests = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    .filter(entry => entry.collaborator === collaborator);
  expect(requests.length).toBeGreaterThan(1);
  return requests.at(-1).request.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(block => block.type === 'tool_result');
}

describe('worker skill catalogs', () => {
  it.each([false, true])('preserves the explicit source across serialization (collaborator: %s)', async collaborator => {
    const captureRequestsFile = join(directory, 'requests.jsonl');
    const skill = { name: 'Skill', input: { skill: 'commit' } };
    const session = await runtime.createSession(options(), {
      setup: { module: new URL('./fixtures/setup.mjs', import.meta.url).href, data: { captureRequestsFile,
        tools: collaborator ? [{ name: 'mcp__halo-team__spawn_agent', input: { prompt: 'Load commit.' } }] : [skill],
        collaboratorTools: collaborator ? [skill] : undefined,
      } },
    });
    await session.send('Load the workflow.');
    for await (const _message of session.stream()) { /* consume the actual worker execution */ }
    const loaded = await results(captureRequestsFile, collaborator);
    expect(loaded.some(result => result.content === 'FOREIGN_COMMIT_BODY')).toBe(true);
    expect(JSON.stringify(loaded)).not.toContain('LOCAL_COMMIT_BODY');
    session.close(); await session.flush();
  });

  it('preserves an explicitly empty catalog through a worker collaborator', async () => {
    const captureRequestsFile = join(directory, 'requests.jsonl');
    const session = await runtime.createSession({ ...options(), skillCatalog: [] }, {
      setup: { module: new URL('./fixtures/setup.mjs', import.meta.url).href, data: { captureRequestsFile,
        tools: [{ name: 'mcp__halo-team__spawn_agent', input: { prompt: 'Load commit.' } }],
        collaboratorTools: [{ name: 'Skill', input: { skill: 'commit' } }],
      } },
    });
    await session.send('Load the workflow.');
    for await (const _message of session.stream()) { /* consume */ }
    const loaded = await results(captureRequestsFile, true);
    expect(loaded.some(result => result.is_error)).toBe(true);
    expect(JSON.stringify(loaded)).not.toContain('LOCAL_COMMIT_BODY');
    expect(JSON.stringify(loaded)).not.toContain('Start with the requested scope.');
    session.close(); await session.flush();
  });
});
