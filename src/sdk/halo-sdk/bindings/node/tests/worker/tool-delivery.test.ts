import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createWorkerRuntime, type WorkerRuntime } from '../../worker/index.js';
import type { Options } from '../../index.js';
import { buildWorker } from '../../../../scripts/build-worker.mjs';

let buildDirectory: string;
let directory: string;
let runtime: WorkerRuntime;

beforeAll(async () => {
  buildDirectory = await mkdtemp(join(tmpdir(), 'sdk-delivery-worker-build-'));
  await buildWorker(join(buildDirectory, 'entry.mjs'));
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sdk-delivery-worker-'));
  runtime = createWorkerRuntime({
    workerUrl: pathToFileURL(join(buildDirectory, 'entry.mjs')),
    warmWorkers: 1,
    maxWorkers: 1,
    startupTimeoutMs: 5000,
    closeTimeoutMs: 5000,
  });
});
afterEach(async () => {
  await runtime.close();
  await rm(directory, { recursive: true, force: true });
});
afterAll(async () => {
  await rm(buildDirectory, { recursive: true, force: true });
});

function options(): Options {
  return {
    model: 'fixture',
    apiKey: 'fixture',
    cwd: directory,
    env: {
      HOME: join(directory, 'home'),
      USERPROFILE: join(directory, 'home'),
      CLAUDE_CONFIG_DIR: join(directory, 'state'),
    },
    persistSession: false,
    tools: ['Read'],
    permissionMode: 'bypassPermissions',
    turnEndChecks: { openWork: false, completion: false },
  };
}

describe('worker tool delivery', () => {
  it('keeps the Read token-bounded range intact across the Worker binding', async () => {
    const file = join(directory, 'large.txt');
    const lines = Array.from({ length: 1500 }, (_, index) =>
      `line-${String(index).padStart(4, '0')}-${'x'.repeat(90)}`,
    );
    await writeFile(file, `${lines.join('\n')}\n`);
    const captureRequestsFile = join(directory, 'requests.jsonl');
    const session = await runtime.createSession(options(), {
      setup: {
        module: new URL('../../worker/fixtures/setup.mjs', import.meta.url).href,
        data: { captureRequestsFile, tools: [{ name: 'Read', input: { file_path: file } }] },
      },
    });
    await session.send('Read the large file.');
    for await (const _message of session.stream()) {
      /* consume the actual worker execution */
    }
    const requests = (await readFile(captureRequestsFile, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    const results = requests
      .at(-1)
      .request.messages.flatMap((message: Record<string, unknown>) =>
        Array.isArray(message.content) ? message.content : [],
      )
      .filter((block: Record<string, unknown>) => block.type === 'tool_result');
    const text = results
      .map((block: Record<string, unknown>) => block.content)
      .filter((content: unknown): content is string => typeof content === 'string')
      .join('\n');
    expect(text).toContain('30000 estimated-token output limit');
    expect(text).toContain('This is a partial view.');
    expect(text).not.toContain('[Content truncated:');
    expect(text.length).toBeGreaterThan(50_000);
    session.close();
    await session.flush();
  });
});
