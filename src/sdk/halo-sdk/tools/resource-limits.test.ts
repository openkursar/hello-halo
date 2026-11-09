import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ReadTool } from './read/index.js';
import { EditTool } from './edit/index.js';
import { WriteTool } from './write/index.js';
import { MAX_FILE_BYTES } from './file-access.js';
import { execShellCommand } from './bash/exec.js';
import { BackgroundTaskRegistry } from './bash/background.js';
import { MAX_BACKGROUND_OUTPUT_BYTES, MAX_RETAINED_OUTPUT_BYTES, OUTPUT_RETENTION_MS, pruneOutput } from './bash/output-retention.js';
import { CostTracker } from '../core/cost.js';
import type { ToolContext } from '../types/tool.js';

let directory: string;
const registries: BackgroundTaskRegistry[] = [];
beforeEach(async () => { directory = await fs.mkdtemp(join(tmpdir(), 'sdk-resources-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const registry of registries) registry.dispose();
  await Promise.all(registries.splice(0).map(registry => registry.flush()));
  await fs.rm(directory, { recursive: true, force: true });
});
function context(): ToolContext {
  return { cwd: directory, sessionId: randomUUID(), env: {}, abortSignal: new AbortController().signal,
    costTracker: new CostTracker('test'), currentTurn: 0 };
}
const quote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";
const flood = `${quote(process.execPath)} -e ${quote("for(let i=0;i<1024;i++)process.stdout.write('x'.repeat(65536));process.stdout.write('FINAL_MARKER')")}`;

describe('resource boundaries with real files and processes', () => {
  it('does not grant write authorization after invalid pagination', async () => {
    const file = join(directory, 'unseen.txt');
    await fs.writeFile(file, 'unseen contents');
    const ctx = { ...context(), readFileState: new Map() };
    for (const limit of [NaN, Infinity, -1, 0, 'invalid']) {
      expect((await new ReadTool().execute({ file_path: file, limit }, ctx)).isError).toBe(true);
      expect(ctx.readFileState.size).toBe(0);
    }
    expect((await new WriteTool().execute({ file_path: file, content: 'overwrite' }, ctx)).isError).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('unseen contents');
  });

  it('rejects a 1 GiB sparse file without authorizing edits or changing it', async () => {
    const file = join(directory, 'large.txt');
    const handle = await fs.open(file, 'w');
    await handle.truncate(1024 ** 3);
    await handle.close();
    const ctx = { ...context(), readFileState: new Map() };
    const result = await new ReadTool().execute({ file_path: file, limit: 1 }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('limit');
    expect(ctx.readFileState.size).toBe(0);
    expect((await new EditTool().execute({ file_path: file, old_string: 'a', new_string: 'b' }, ctx)).isError).toBe(true);
    expect((await fs.stat(file)).size).toBe(1024 ** 3);
  });

  it('refuses replacement amplification before allocating or mutating the result', async () => {
    const file = join(directory, 'expand.txt');
    await fs.writeFile(file, 'a'.repeat(4096));
    const result = await new EditTool().execute({ file_path: file, old_string: 'a',
      new_string: 'b'.repeat(4096), replace_all: true }, context());
    expect(result.isError).toBe(true);
    expect((await fs.stat(file)).size).toBe(4096);
    const write = await new WriteTool().execute({ file_path: file, content: 'b'.repeat(MAX_FILE_BYTES + 1) }, context());
    expect(write.isError).toBe(true);
    expect((await fs.stat(file)).size).toBe(4096);
  });

  it('bounds foreground capture while draining a 64 MiB producer to completion', async () => {
    const result = await execShellCommand({ command: flood, state: { cwd: directory, envVars: new Map() }, timeoutMs: 30_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeLessThan(66_000);
    expect(result.stdout).toContain('output truncated');
    expect(result.stdout).toContain('FINAL_MARKER');
  });

  it('bounds persisted background output and reports truncation', async () => {
    const registry = new BackgroundTaskRegistry({ outputDir: directory });
    registries.push(registry);
    const task = await registry.start({ command: flood, state: { cwd: directory, envVars: new Map() }, env: {},
      timeoutMs: 30_000, abortSignal: new AbortController().signal });
    await task.done;
    expect(task.status).toBe('completed');
    expect((await fs.stat(task.outputFile)).size).toBeLessThanOrEqual(MAX_BACKGROUND_OUTPUT_BYTES);
    expect(task.outputTruncated).toBe(true);
    expect((await registry.readOutput(task)).truncated).toBe(true);
    expect((await fs.readFile(task.outputFile, 'utf8')).endsWith('your own file.]\n')).toBe(true);
  });

  it('settles a command after a failed disk write and removes its process', async () => {
    const open = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith('.output')) {
        vi.spyOn(handle, 'writeFile').mockRejectedValue(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
      }
      return handle;
    });
    const registry = new BackgroundTaskRegistry({ outputDir: directory });
    registries.push(registry);
    const task = await registry.start({ command: flood, state: { cwd: directory, envVars: new Map() }, env: {},
      timeoutMs: 30_000, abortSignal: new AbortController().signal });
    await task.done;
    expect(task.status).toBe('failed');
    expect(task.error).toBe('Output persistence failed');
    expect(() => process.kill(task.pid!, 0)).toThrow();
  }, 5000);

  it('finishes cleanup even if the consumer throws on a completion notice', async () => {
    const registry = new BackgroundTaskRegistry({ outputDir: directory, onNotice: () => { throw new Error('consumer gone'); } });
    registries.push(registry);
    const task = await registry.start({ command: 'printf complete', state: { cwd: directory, envVars: new Map() }, env: {},
      timeoutMs: 30_000, abortSignal: new AbortController().signal });
    await task.done;
    expect(task.status).toBe('completed');
    await fs.rm(task.outputFile);
    const output = await registry.readOutput(task);
    expect(output.truncated).toBe(true);
    expect(output.output).toContain('no longer available');
  }, 5000);

  it('prunes global completed output by bytes and age, preserving active and unrelated files', async () => {
    for (let index = 0; index < 40; index++) {
      const file = join(directory, `bash-${randomUUID()}.output`);
      const handle = await fs.open(file, 'w');
      await handle.truncate(MAX_BACKGROUND_OUTPUT_BYTES);
      await handle.close();
      await fs.writeFile(file + '.done', '');
      if (index === 0) await fs.utimes(file, 1, (Date.now() - OUTPUT_RETENTION_MS - 1000) / 1000);
    }
    const active = join(directory, `bash-${randomUUID()}.output`);
    await fs.writeFile(active, 'active');
    await fs.writeFile(join(directory, 'user-file'), 'keep');
    await Promise.all([pruneOutput(directory), pruneOutput(directory)]);
    let size = 0;
    for (const name of await fs.readdir(directory)) {
      if (name.endsWith('.output')) size += (await fs.stat(join(directory, name))).size;
    }
    expect(size).toBeLessThanOrEqual(MAX_RETAINED_OUTPUT_BYTES + 6);
    expect(await fs.readFile(active, 'utf8')).toBe('active');
    expect(await fs.readFile(join(directory, 'user-file'), 'utf8')).toBe('keep');
  });
});
