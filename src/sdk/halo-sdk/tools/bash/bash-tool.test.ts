/**
 * @module tools/bash/bash-tool.test
 * Unit tests for BashTool, BackgroundTaskRegistry, and truncateBashOutput.
 * Uses real child_process spawning for execution tests.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import { TaskOutputTool, TaskStopTool } from '../task/index.js';
import { ReadTool } from '../read/index.js';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ToolContext } from '../../types/tool.js';
import { CostTracker } from '../../core/cost.js';
import { truncateBashOutput, MAX_OUTPUT_LEN } from './truncate.js';
import { BackgroundTaskRegistry } from './background.js';
import { BashTool } from './index.js';
import { shellStateManager } from './shell-state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const registries: BackgroundTaskRegistry[] = [];
const sessionIds: string[] = [];
function makeCtx(opts?: { sessionId?: string; cwd?: string }): ToolContext {
  const registry = new BackgroundTaskRegistry();
  registries.push(registry);
  const sessionId = opts?.sessionId ?? randomUUID();
  sessionIds.push(sessionId);
  return {
    sessionId,
    services: { backgroundTasks: registry },
    cwd: opts?.cwd ?? os.tmpdir(),
    abortSignal: new AbortController().signal,
    costTracker: new CostTracker('test-model'),
    currentTurn: 0,
    env: {},
  };
}

const tool = BashTool;

afterEach(async () => {
  for (const registry of registries) registry.dispose();
  await Promise.all(registries.splice(0).map(registry => registry.flush()));
  for (const id of sessionIds.splice(0)) shellStateManager.remove(id);
});

// ===========================================================================
// truncateBashOutput
// ===========================================================================

describe('truncateBashOutput', () => {
  it('returns output unchanged when within limit', () => {
    const s = 'a'.repeat(100);
    expect(truncateBashOutput(s)).toBe(s);
  });

  it('returns output unchanged when exactly at limit', () => {
    const s = 'x'.repeat(MAX_OUTPUT_LEN);
    expect(truncateBashOutput(s)).toBe(s);
  });

  it('truncates output over the limit keeping head and tail', () => {
    const s = 'a'.repeat(MAX_OUTPUT_LEN + 200);
    const result = truncateBashOutput(s);
    expect(result).toContain('omitted from the middle');
    expect(result.startsWith('a'.repeat(1000))).toBe(true);
    expect(result.endsWith('a'.repeat(1000))).toBe(true);
    expect(result.length).toBeLessThanOrEqual(MAX_OUTPUT_LEN);
  });

  it('preserves both the head and the tail of the output', () => {
    const head = 'HEAD'.repeat(50);
    const tail = 'TAIL'.repeat(50);
    const filler = 'X'.repeat(MAX_OUTPUT_LEN);
    const s = head + filler + tail;
    const result = truncateBashOutput(s);
    expect(result.startsWith(head)).toBe(true);
    expect(result.endsWith(tail)).toBe(true);
  });

  it('reports omitted characters and a safe recovery hint', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const s = lines.join('\n');
    const result = truncateBashOutput(s, 400);
    expect(result).toMatch(/\d+ chars omitted from the middle/);
    expect(result).toContain('If repeating the command is safe');
    expect(result.length).toBeLessThanOrEqual(400);
  });

  it('respects a custom maxLen parameter', () => {
    const s = 'a'.repeat(50);
    const result = truncateBashOutput(s, 20);
    expect(result).toContain('truncated');
    expect(result.length).toBeLessThanOrEqual(20);
  });
});

// ===========================================================================
// BackgroundTaskRegistry
// ===========================================================================

describe('BackgroundTaskRegistry', () => {
  it('returns undefined for an unknown task ID', () => {
    expect(new BackgroundTaskRegistry().get('nonexistent')).toBeUndefined();
  });
});

// ===========================================================================
// BashTool.execute() — input validation
// ===========================================================================

describe('BashTool — input validation', () => {
  it('returns error when command is missing', async () => {
    const result = await tool.execute({}, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('command');
  });

  it('returns error when command is not a string', async () => {
    const result = await tool.execute({ command: 42 }, makeCtx());
    expect(result.isError).toBe(true);
  });

  it('has correct permissionLevel', () => {
    expect(tool.permissionLevel).toBe('execute');
  });

  it('has the name "Bash"', () => {
    expect(tool.name).toBe('Bash');
  });
});

// ===========================================================================
// BashTool.execute() — foreground execution (real subprocess)
// ===========================================================================

describe('BashTool — foreground execution', () => {
  it('executes a simple echo command', async () => {
    const result = await tool.execute({ command: 'echo hello' }, makeCtx());
    expect(result.isError).toBe(false);
    expect(result.content).toContain('hello');
  });

  it('returns toolError for non-zero exit code', async () => {
    const result = await tool.execute({ command: 'exit 42' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('42');
  });

  it('includes STDERR output in result', async () => {
    const result = await tool.execute(
      { command: 'echo error_message >&2' },
      makeCtx(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('error_message');
  });

  it('returns "(No output)" when command produces no output', async () => {
    const result = await tool.execute({ command: 'true' }, makeCtx());
    expect(result.isError).toBe(false);
    expect(result.content).toBe('(No output)');
  });

  it('handles multiline command output', async () => {
    const result = await tool.execute(
      { command: 'printf "line1\\nline2\\nline3"' },
      makeCtx(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('line1');
    expect(result.content).toContain('line2');
    expect(result.content).toContain('line3');
  });

  it('executes arithmetic via bash built-ins', async () => {
    const result = await tool.execute(
      { command: 'echo $((2 + 2))' },
      makeCtx(),
    );
    expect(result.isError).toBe(false);
    expect(result.content.trim()).toBe('4');
  });

  it('fails gracefully on spawn error for invalid executable', async () => {
    // Using a command that will definitely fail with non-zero exit
    const result = await tool.execute(
      { command: '__nonexistent_cmd_xyz__' },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
  });
});

// ===========================================================================
// BashTool — shell state persistence
// ===========================================================================

describe('BashTool — shell state persistence', () => {
  it('tracks cwd changes across two calls', async () => {
    const sessionId = randomUUID();
    const ctx = makeCtx({ sessionId });

    const pwd = process.platform === 'win32' ? 'pwd -P -W' : 'pwd -P';
    const first = await tool.execute({ command: `cd /tmp; ${pwd}` }, ctx);
    expect(first.isError).toBe(false);
    const result = await tool.execute({ command: pwd }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content.trim()).toBe(first.content.trim());
  });

  it('persists exported env vars across calls', async () => {
    const sessionId = randomUUID();
    const ctx = makeCtx({ sessionId });

    await tool.execute({ command: 'export MY_TEST_VAR=hello123' }, ctx);

    const result = await tool.execute({ command: 'echo $MY_TEST_VAR' }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content.trim()).toBe('hello123');
  });

  it('isolates state between different sessions', async () => {
    const sessionA = randomUUID();
    const sessionB = randomUUID();

    const ctxA = makeCtx({ sessionId: sessionA });
    const ctxB = makeCtx({ sessionId: sessionB });

    // Set var in session A
    await tool.execute({ command: 'export ISOLATED_VAR=from_A' }, ctxA);

    // Session B should not see ISOLATED_VAR
    const result = await tool.execute(
      { command: 'echo "${ISOLATED_VAR:-not_set}"' },
      ctxB,
    );
    expect(result.isError).toBe(false);
    expect(result.content.trim()).toBe('not_set');
  });
});

// ===========================================================================
// BashTool — background execution
// ===========================================================================

describe('BashTool — background execution', () => {
  it('keeps background work alive beyond the foreground default until explicitly stopped', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ctx = makeCtx();
    const registry = ctx.services!.backgroundTasks!;
    try {
      const result = await tool.execute({ command: 'sleep 30', run_in_background: true }, ctx);
      const task = registry.get(result.metadata!.task_id as string)!;
      expect(result.content).toContain('No execution deadline was set');
      expect(result.content).toContain('session is closed or interrupted');
      await vi.advanceTimersByTimeAsync(120_001);
      expect(task.status).toBe('running');
      expect(registry.stop(task.id)).toBe(true);
      await task.done;
      expect(task.status).toBe('stopped');
    } finally {
      registry.dispose();
      await registry.flush();
      vi.useRealTimers();
    }
  });

  it('returns a message with Task ID when run_in_background is true', async () => {
    const result = await tool.execute(
      { command: 'echo bg_test', run_in_background: true },
      makeCtx(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('background');
    expect(result.content).toMatch(/ID:/i);
  });

  it('writes exact output to a readable file and sends one completion notice', async () => {
    const notices: string[] = [];
    const ctx = makeCtx();
    const registry = new BackgroundTaskRegistry({ onNotice: notice => notices.push(notice) });
    registries.push(registry);
    ctx.services = { backgroundTasks: registry };
    const result = await tool.execute({ command: 'printf "one\\n\\n"; printf "two" >&2', run_in_background: true }, ctx);
    const id = result.metadata!.task_id as string;
    const task = registry.get(id)!;
    await task.done;
    expect(task.status).toBe('completed');
    expect(await fs.readFile(task.outputFile, 'utf8')).toBe('one\n\ntwo');
    const read = await new ReadTool().execute({ file_path: task.outputFile }, ctx);
    expect(read.isError).toBe(false);
    expect(read.content).toContain('two');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(task.outputFile);
    const status = await TaskOutputTool.execute({ task_id: id }, ctx);
    expect(JSON.parse(status.content).task.result).toBe('one\n\ntwo');
    expect(await TaskOutputTool.execute({ task_id: id }, makeCtx())).toMatchObject({ isError: true });
  });

  it('inherits session environment and shell exports without writing state back', async () => {
    const ctx = makeCtx();
    ctx.env = { BACKGROUND_CONFIG: 'session-value' };
    await tool.execute({ command: 'export BACKGROUND_SAVED=saved-value' }, ctx);
    const result = await tool.execute({ command: 'printf "$BACKGROUND_CONFIG:$BACKGROUND_SAVED"; export BACKGROUND_SAVED=changed', run_in_background: true }, ctx);
    const task = ctx.services!.backgroundTasks!.get(result.metadata!.task_id as string)!;
    await task.done;
    expect(await fs.readFile(task.outputFile, 'utf8')).toBe('session-value:saved-value');
    expect((await tool.execute({ command: 'printf "$BACKGROUND_SAVED"' }, ctx)).content).toBe('saved-value');
  });

  it('stops a real process by ID without affecting another session', async () => {
    const ctx = makeCtx();
    const result = await tool.execute({ command: 'sleep 30', run_in_background: true }, ctx);
    const id = result.metadata!.task_id as string;
    const task = ctx.services!.backgroundTasks!.get(id)!;
    expect((await TaskStopTool.execute({ task_id: id }, makeCtx())).isError).toBe(true);
    expect((await TaskStopTool.execute({ task_id: id }, ctx)).isError).toBe(false);
    await task.done;
    expect(task.status).toBe('stopped');
    expect(() => process.kill(task.pid!, 0)).toThrow();
  });

  it.skipIf(process.platform === 'win32')('stops a TERM-ignoring descendant before shutdown completes', async () => {
    let connected!: (socket: import('node:net').Socket) => void;
    const ready = new Promise<import('node:net').Socket>(resolve => { connected = resolve; });
    const server = createServer(socket => connected(socket));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as import('node:net').AddressInfo).port;
    const script = `process.on('SIGTERM',()=>{});require('node:net').connect(${port},'127.0.0.1');setInterval(()=>{},1000)`;
    const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
    const ctx = makeCtx();
    try {
      const result = await tool.execute({ command: `${quote(process.execPath)} -e ${quote(script)} & wait`, run_in_background: true }, ctx);
      const task = ctx.services!.backgroundTasks!.get(result.metadata!.task_id as string)!;
      const socket = await ready;
      const disconnected = new Promise<void>(resolve => socket.on('close', resolve));
      expect((await TaskStopTool.execute({ task_id: task.id }, ctx)).isError).toBe(false);
      await Promise.all([task.done, disconnected]);
      expect(task.status).toBe('stopped');
    } finally {
      ctx.services!.backgroundTasks!.dispose();
      await ctx.services!.backgroundTasks!.flush();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('keeps timeout failure terminal and reports nonzero exits', async () => {
    const ctx = makeCtx();
    const launched = await tool.execute({ command: 'sleep 30', timeout: 50, run_in_background: true }, ctx);
    expect(launched.content).toContain('Execution deadline: 50ms from launch');
    const task = ctx.services!.backgroundTasks!.get(launched.metadata!.task_id as string)!;
    await task.done;
    expect(task.status).toBe('failed');
    expect(task.error).toContain('Timed out');
    const failed = await tool.execute({ command: 'printf failure; exit 7', run_in_background: true }, ctx);
    const failedTask = ctx.services!.backgroundTasks!.get(failed.metadata!.task_id as string)!;
    await failedTask.done;
    expect(failedTask.status).toBe('failed');
    expect(failedTask.exitCode).toBe(7);
  });

  it('bounds query output without retaining stdout in memory', async () => {
    const ctx = makeCtx();
    const result = await tool.execute({ command: 'printf "%040000d" 0', run_in_background: true }, ctx);
    const id = result.metadata!.task_id as string;
    const task = ctx.services!.backgroundTasks!.get(id)!;
    await task.done;
    const output = JSON.parse((await TaskOutputTool.execute({ task_id: id }, ctx)).content);
    expect(output.task.truncated).toBe(true);
    expect(output.task.result.length).toBe(32 * 1024);
    expect((await fs.stat(task.outputFile)).size).toBe(40_000);
    expect(task).not.toHaveProperty('output');
  });

  it('does not subscribe to the invoking tool abort signal and removes temporary output on close', async () => {
    const ctx = makeCtx();
    const controller = new AbortController();
    ctx.abortSignal = controller.signal;
    const launched = await tool.execute({ command: 'sleep 30', run_in_background: true }, ctx);
    const registry = ctx.services!.backgroundTasks!;
    const task = registry.get(launched.metadata!.task_id as string)!;
    controller.abort();
    expect(task.status).toBe('running');
    registry.dispose();
    await registry.flush();
    expect(task.status).toBe('stopped');
    await expect(fs.stat(task.outputFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(registry.getAll()).toHaveLength(0);
  });

  it('rejects background execution without session services or after cancellation', async () => {
    const ctx = makeCtx();
    ctx.services = undefined;
    expect((await tool.execute({ command: 'true', run_in_background: true }, ctx)).isError).toBe(true);
    const cancelled = makeCtx();
    const controller = new AbortController();
    controller.abort();
    cancelled.abortSignal = controller.signal;
    expect((await tool.execute({ command: 'true', run_in_background: true }, cancelled)).isError).toBe(true);
    expect(cancelled.services!.backgroundTasks!.getAll()).toHaveLength(0);
  });
});

// ===========================================================================
// BashTool — abort signal
// ===========================================================================

describe('BashTool — abort signal', () => {
  it('handles pre-aborted signal (process killed immediately)', async () => {
    const ctrl = new AbortController();
    ctrl.abort();

    const ctx: ToolContext = {
      sessionId: randomUUID(),
      cwd: os.tmpdir(),
      abortSignal: ctrl.signal,
      costTracker: new CostTracker('test-model'),
      currentTurn: 0,
      env: {},
    };

    // The command may not even run since the signal is already aborted.
    // It should not hang.
    const resultPromise = tool.execute({ command: 'echo should_abort' }, ctx);
    const result = await resultPromise;
    // Either the command ran before abort was detected, or it failed — both are valid.
    // The key assertion is that it completes within a reasonable time (no hang).
    expect(typeof result.content).toBe('string');
  });
});

// ===========================================================================
// BashTool — timeout
// ===========================================================================

describe('BashTool — timeout', () => {
  it('preserves stdout and stderr captured before termination', async () => {
    const result = await tool.execute({
      command: 'printf "Processed 12 items\\n"; printf "Checkpoint saved\\n" >&2; sleep 30',
      timeout: 300,
    }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('timed out after 300ms');
    expect(result.content).toContain('Processed 12 items');
    expect(result.content).toContain('Checkpoint saved');
    expect(result.content).toContain('Inspect its output and saved files before repeating it');
  });

  it('bounds timeout output while retaining the final diagnostic', async () => {
    const result = await tool.execute({
      command: 'printf "%070000d\\n" 0; printf "LAST_DIAGNOSTIC\\n" >&2; sleep 30',
      timeout: 300,
    }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(MAX_OUTPUT_LEN);
    expect(result.content).toContain('timed out after 300ms');
    expect(result.content).toContain('omitted');
    expect(result.content).toContain('LAST_DIAGNOSTIC');
  });

  it('terminates a command that exceeds the timeout', async () => {
    const result = await tool.execute(
      { command: 'sleep 30', timeout: 300 }, // 300ms timeout
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('timed out');
  }, 10_000);
});
