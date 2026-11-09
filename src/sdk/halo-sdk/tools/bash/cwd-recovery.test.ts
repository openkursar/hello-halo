import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CostTracker } from '../../core/cost.js';
import type { ToolContext } from '../../types/tool.js';
import { BashTool } from './index.js';
import { BackgroundTaskRegistry } from './background.js';
import { shellStateManager } from './shell-state.js';
import { posixQuote } from './shell-quote.js';
import { windowsPathToPosixPath } from './windows-paths.js';

const contexts: ToolContext[] = [];
const roots: string[] = [];
const quotePath = (value: string) => posixQuote(process.platform === 'win32' ? windowsPathToPosixPath(value) : value);

async function setup() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'sdk-cwd-recovery-')));
  roots.push(root);
  const child = join(root, 'child');
  await fs.mkdir(child);
  const ctx: ToolContext = {
    sessionId: randomUUID(), cwd: root,
    env: process.platform === 'win32' ? {} : { AGENT_SHELL: '/bin/bash' },
    abortSignal: new AbortController().signal,
    costTracker: new CostTracker('test-model'), currentTurn: 0,
    services: { backgroundTasks: new BackgroundTaskRegistry() },
  };
  contexts.push(ctx);
  return { root, child, ctx };
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    ctx.services!.backgroundTasks!.dispose();
    await ctx.services!.backgroundTasks!.flush();
    shellStateManager.remove(ctx.sessionId);
  }
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('Bash working directory recovery', () => {
  it('recovers before spawning after another process removes the saved directory', async () => {
    const { root, child, ctx } = await setup();
    await BashTool.execute({ command: `cd ${quotePath(child)}; export HALO_CWD_TEST=retained` }, ctx);
    await fs.rm(child, { recursive: true });
    const result = await BashTool.execute({ command: 'printf "%s\\n" "$HALO_CWD_TEST" "$PWD"; pwd -P' }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('retained');
    expect(result.content).toContain('Running in session directory');
    expect(result.content).not.toContain(child);
    expect(shellStateManager.get(ctx.sessionId, root).cwd).toBe(root);
    const next = await BashTool.execute({ command: 'echo recovered' }, ctx);
    expect(next.content).toBe('recovered');
  });

  it('preserves directory and exports when Bash deletes its own cwd', async () => {
    const { root, child, ctx } = await setup();
    const removed = await BashTool.execute({
      command: `cd ${quotePath(child)}; export HALO_CWD_TEST=retained; rm -rf ${quotePath(child)}; (exit 7)`,
    }, ctx);
    expect(removed.isError).toBe(true);
    expect(removed.content).toContain('code 7');
    expect(shellStateManager.get(ctx.sessionId, root).cwd).toBe(root);
    expect(shellStateManager.get(ctx.sessionId, root).envVars.get('HALO_CWD_TEST')).toBe('retained');
    await fs.mkdir(child);
    const result = await BashTool.execute({ command: 'echo "$HALO_CWD_TEST"; pwd -P' }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('retained');
    expect(shellStateManager.get(ctx.sessionId, root).cwd).toBe(root);
  });

  it('recovers background launches and reports the directory change immediately', async () => {
    const { root, child, ctx } = await setup();
    await BashTool.execute({ command: `cd ${quotePath(child)}; export HALO_CWD_TEST=background` }, ctx);
    await fs.rm(child, { recursive: true });
    const result = await BashTool.execute({ command: 'echo "$HALO_CWD_TEST"; pwd -P', run_in_background: true }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Running in session directory');
    const registry = ctx.services!.backgroundTasks!;
    const task = registry.getAll()[0]!;
    await task.done;
    expect(task.status).toBe('completed');
    expect((await registry.readOutput(task)).output).toContain('background');
    expect((await registry.readOutput(task)).output).toContain(process.platform === 'win32' ? windowsPathToPosixPath(root) : root);
  });

  it.each([false, true])('does not execute when both directories are missing (background=%s)', async background => {
    const { root, child, ctx } = await setup();
    await BashTool.execute({ command: `cd ${quotePath(child)}` }, ctx);
    await fs.rm(root, { recursive: true });
    const result = await BashTool.execute({
      command: 'export HALO_NOT_EXECUTED=yes; echo MUST_NOT_RUN', run_in_background: background,
    }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Command not started');
    expect(result.content).not.toContain('MUST_NOT_RUN');
    expect(shellStateManager.get(ctx.sessionId, root).envVars.has('HALO_NOT_EXECUTED')).toBe(false);
    expect(ctx.services!.backgroundTasks!.getAll()).toHaveLength(0);
  });

  it('keeps a valid saved directory when the original session directory disappears', async () => {
    const { root, ctx } = await setup();
    const other = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'sdk-cwd-other-')));
    roots.push(other);
    await BashTool.execute({ command: `cd ${quotePath(other)}` }, ctx);
    await fs.rm(root, { recursive: true });
    const result = await BashTool.execute({ command: 'pwd -P' }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain('Running in session directory');
    expect(shellStateManager.get(ctx.sessionId, root).cwd).toBe(other);
  });

  it('recovers an old malformed directory state without exposing its contents', async () => {
    const { root, ctx } = await setup();
    shellStateManager.get(ctx.sessionId, root).cwd = 'SECRET=fixture-value';
    const result = await BashTool.execute({ command: 'pwd -P' }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('invalid_path');
    expect(result.content).not.toContain('fixture-value');
    expect(shellStateManager.get(ctx.sessionId, root).cwd).toBe(root);
  });

  it('recovers when the saved directory is replaced by a file', async () => {
    const { root, child, ctx } = await setup();
    await BashTool.execute({ command: `cd ${quotePath(child)}` }, ctx);
    await fs.rm(child, { recursive: true });
    await fs.writeFile(child, 'replacement');
    const result = await BashTool.execute({ command: 'pwd -P' }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('not_directory');
    expect(shellStateManager.get(ctx.sessionId, root).cwd).toBe(root);
  });
});
