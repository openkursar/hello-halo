import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getAllTools, releaseNativeToolOwner } from '../../native/tools.js';
import { CostTracker } from '../../native/values.js';
import type { ToolContext } from '../../types/tool.js';

let directory: string;
const owners: string[] = [];
beforeEach(async () => { directory = await fs.mkdtemp(join(tmpdir(), 'sdk-resources-')); });
afterEach(async () => {
  await Promise.all(owners.splice(0).map(releaseNativeToolOwner));
  await fs.rm(directory, { recursive: true, force: true });
});
function context(): ToolContext {
  const sessionId = randomUUID();
  owners.push(sessionId);
  return { cwd: directory, sessionId, env: {}, abortSignal: new AbortController().signal,
    costTracker: new CostTracker('test'), currentTurn: 0 };
}
const tool = (name: string) => getAllTools().find(tool => tool.name === name)!;
const quote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";
const flood = `${quote(process.execPath)} -e ${quote("for(let i=0;i<1024;i++)process.stdout.write('x'.repeat(65536));process.stdout.write('FINAL_MARKER')")}`;

describe('resource boundaries with real files and processes', () => {
  it('does not grant edit authorization after invalid pagination', async () => {
    const file = join(directory, 'unseen.txt');
    await fs.writeFile(file, 'unseen contents');
    const ctx = { ...context(), readFileState: new Map() };
    for (const limit of [NaN, Infinity, -1, 0, 'invalid']) {
      expect((await tool('Read').execute({ file_path: file, limit }, ctx)).isError).toBe(true);
      expect(ctx.readFileState.size).toBe(0);
    }
    expect((await tool('Edit').execute({ file_path: file, old_string: 'unseen', new_string: 'overwrite' }, ctx)).isError).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('unseen contents');
  });

  it('rejects a 1 GiB sparse file without authorizing edits or changing it', async () => {
    const file = join(directory, 'large.txt');
    const handle = await fs.open(file, 'w');
    await handle.truncate(1024 ** 3);
    await handle.close();
    const ctx = { ...context(), readFileState: new Map() };
    const result = await tool('Read').execute({ file_path: file, limit: 1 }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('limit');
    expect(ctx.readFileState.size).toBe(0);
    expect((await tool('Edit').execute({ file_path: file, old_string: 'a', new_string: 'b' }, ctx)).isError).toBe(true);
    expect((await fs.stat(file)).size).toBe(1024 ** 3);
  });

  it('refuses replacement amplification before mutating the result', async () => {
    const file = join(directory, 'expand.txt');
    await fs.writeFile(file, 'a'.repeat(4096));
    const ctx = { ...context(), readFileState: new Map() };
    await tool('Read').execute({ file_path: file }, ctx);
    const result = await tool('Edit').execute({ file_path: file, old_string: 'a',
      new_string: 'b'.repeat(4096), replace_all: true }, ctx);
    expect(result.isError).toBe(true);
    expect((await fs.stat(file)).size).toBe(4096);
    const write = await tool('Write').execute({ file_path: file, content: 'b'.repeat(8 * 1024 * 1024 + 1) }, ctx);
    expect(write.isError).toBe(true);
    expect((await fs.stat(file)).size).toBe(4096);
  });

  it('bounds foreground capture while draining a 64 MiB producer to completion', async () => {
    const result = await tool('Bash').execute({ command: flood, timeout: 30_000 }, context());
    expect(result.isError).toBe(false);
    expect((result.content as string).length).toBeLessThan(66_000);
    expect(result.content).toContain('Content truncated:');
    expect(result.content).toContain('FINAL_MARKER');
  });

});
