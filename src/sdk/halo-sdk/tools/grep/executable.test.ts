import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accessSync, constants } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { GrepTool } from './index.js';
import type { ToolContext } from '../../types/tool.js';

const installedRg = (process.env.PATH ?? '').split(delimiter).map(directory => join(directory, 'rg')).find(candidate => {
  try { accessSync(candidate, constants.X_OK); return true; } catch { return false; }
});

let root: string;
let bin: string;
function context(env: NodeJS.ProcessEnv): ToolContext {
  return { cwd: root, env, sessionId: 'grep-executable-test', currentTurn: 0,
    abortSignal: new AbortController().signal, costTracker: {} as ToolContext['costTracker'] };
}

async function program(name: string, body: string): Promise<string> {
  const file = join(bin, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

describe.skipIf(process.platform === 'win32')('Grep executable integration', () => {
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'grep-host-')));
    bin = join(root, 'host tools');
    await mkdir(bin);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('runs an absolute path with spaces without a system PATH and keeps concurrent environments separate', async () => {
    const executable = await program('search program', 'printf \'%s\\n\' "$GREP_TEST_MARKER"');
    const before = process.env.GREP_TEST_MARKER;
    const tool = new GrepTool();
    const [first, second] = await Promise.all(['first', 'second'].map(marker => tool.execute({ pattern: 'unused' },
      context({ AGENT_RIPGREP_PATH: executable, PATH: join(root, 'missing'), GREP_TEST_MARKER: marker }))));
    expect(first).toMatchObject({ isError: false, content: 'first' });
    expect(second).toMatchObject({ isError: false, content: 'second' });
    expect(process.env.GREP_TEST_MARKER).toBe(before);
  });

  it('falls back to the session PATH for a relative override', async () => {
    await program('rg', "printf 'path fallback\\n'");
    const result = await new GrepTool().execute({ pattern: 'unused' }, context({ AGENT_RIPGREP_PATH: './relative/rg', PATH: bin }));
    expect(result).toMatchObject({ isError: false, content: 'path fallback' });
  });

  it('distinguishes a missing PATH program from a broken configured executable', async () => {
    const tool = new GrepTool();
    const missing = await tool.execute({ pattern: 'unused' }, context({ AGENT_RIPGREP_PATH: undefined, PATH: join(root, 'missing') }));
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain('session PATH');
    await program('rg', "printf 'must not fall back\\n'");
    const configured = await tool.execute({ pattern: 'unused' }, context({ AGENT_RIPGREP_PATH: join(bin, 'missing'), PATH: bin }));
    expect(configured.isError).toBe(true);
    expect(configured.content).toContain('configured ripgrep executable');
    expect(configured.content).not.toContain('must not fall back');
  });

  it.skipIf(!installedRg)('preserves denial exclusions and pagination with the real configured ripgrep', async () => {
    const executable = join(bin, 'bundled rg');
    await symlink(installedRg!, executable);
    await writeFile(join(root, 'visible.txt'), 'needle one\nneedle two\nneedle three\n');
    const denied = join(root, 'private.txt');
    await writeFile(denied, 'needle PRIVATE\n');
    const ctx = context({ AGENT_RIPGREP_PATH: executable, PATH: join(root, 'missing') });
    ctx.readDenyRoots = [denied];
    const result = await new GrepTool().execute({ pattern: 'needle', output_mode: 'content', head_limit: 1, offset: 1 }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('needle two');
    expect(result.content).toContain('Showing lines 2-2 of 3 matching lines');
    expect(result.content).not.toContain('PRIVATE');
    const refused = await new GrepTool().execute({ pattern: 'needle', path: denied }, ctx);
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain('denied');
  });
});
