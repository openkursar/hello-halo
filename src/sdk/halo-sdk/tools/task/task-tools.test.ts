/**
 * @module tools/task/task-tools.test
 * Unit tests for TaskStopTool and TaskOutputTool.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { BackgroundTaskRegistry } from '../bash/background.js';
import type { ToolContext } from '../../types/tool.js';
import { CostTracker } from '../../core/cost.js';
import { TaskStopTool, TaskOutputTool } from './index.js';

let ctx: ToolContext;

function useRegistry(registry: unknown): void {
  ctx.services = { backgroundTasks: registry as BackgroundTaskRegistry };
}

function makeRegistry(entry: Record<string, unknown> | undefined, stopResult = true) {
  return {
    get: vi.fn().mockReturnValue(entry),
    readOutput: vi.fn(async () => ({ output: entry?.result ?? '', truncated: false })),
    stop: vi.fn().mockReturnValue(stopResult),
    list: vi.fn().mockReturnValue(entry ? [entry] : []),
    register: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
  };
}

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bash-1',
    command: 'echo background-output',
    status: 'running',
    startedAt: Date.now(),
    completedAt: null,
    result: undefined,
    error: undefined,
    done: Promise.resolve(),
    ...overrides,
  };
}

beforeEach(() => {
  ctx = {
    sessionId: randomUUID(),
    cwd: '/tmp',
    abortSignal: new AbortController().signal,
    costTracker: new CostTracker('test-model'),
    currentTurn: 0,
    env: {},
  };
});

describe('TaskStopTool', () => {
  it('has correct metadata', () => {
    expect(TaskStopTool.name).toBe('TaskStop');
    expect(TaskStopTool.permissionLevel).toBe('execute');
  });

  it('returns error when task_id is missing', async () => {
    const result = await TaskStopTool.execute({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('task_id');
  });

  it('returns not found when no shell service is wired', async () => {
    const result = await TaskStopTool.execute({ task_id: 'bash-ghost' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  it('returns not found for an unknown command', async () => {
    useRegistry(makeRegistry(undefined));
    const result = await TaskStopTool.execute({ task_id: 'bash-ghost' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  it('stops a running command', async () => {
    const registry = makeRegistry(makeEntry({ id: 'bash-123' }));
    useRegistry(registry);

    const result = await TaskStopTool.execute({ task_id: 'bash-123' }, ctx);

    expect(result.isError).toBe(false);
    expect(registry.stop).toHaveBeenCalledWith('bash-123');
    expect(JSON.parse(result.content as string).task_id).toBe('bash-123');
  });

  it('returns error when the command is not running', async () => {
    useRegistry(makeRegistry(makeEntry({ status: 'completed' }), false));
    const result = await TaskStopTool.execute({ task_id: 'bash-1' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not running');
  });

  it('returns error when the registry fails to stop the command', async () => {
    useRegistry(makeRegistry(makeEntry(), false));
    const result = await TaskStopTool.execute({ task_id: 'bash-1' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Failed to stop');
  });
});

describe('TaskOutputTool', () => {
  it('has correct metadata', () => {
    expect(TaskOutputTool.name).toBe('TaskOutput');
    expect(TaskOutputTool.permissionLevel).toBe('none');
  });

  it('returns error when task_id is missing', async () => {
    const result = await TaskOutputTool.execute({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('task_id');
  });

  it('returns not found when no shell service is wired', async () => {
    const result = await TaskOutputTool.execute({ task_id: 'bash-ghost' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  it('returns the result of a finished command', async () => {
    useRegistry(makeRegistry(makeEntry({
      id: 'bash-789',
      status: 'completed',
      completedAt: Date.now(),
      result: 'shell output',
    })));

    const result = await TaskOutputTool.execute({ task_id: 'bash-789', block: false }, ctx);

    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content as string);
    expect(data.retrieval_status).toBe('success');
    expect(data.task.task_id).toBe('bash-789');
    expect(data.task.result).toBe('shell output');
  });

  it('reports not_ready for a running command when block=false', async () => {
    useRegistry(makeRegistry(makeEntry()));
    const result = await TaskOutputTool.execute({ task_id: 'bash-1', block: false }, ctx);
    expect(JSON.parse(result.content as string).retrieval_status).toBe('not_ready');
  });

  it('cancels a blocking wait without stopping the task', async () => {
    const controller = new AbortController();
    ctx.abortSignal = controller.signal;
    const registry = makeRegistry(makeEntry({ done: new Promise(() => {}) }));
    useRegistry(registry);
    const pending = TaskOutputTool.execute({ task_id: 'bash-1' }, ctx);
    controller.abort();
    expect((await pending).isError).toBe(true);
    expect(registry.stop).not.toHaveBeenCalled();
  });

  it('accepts zero timeout without retaining wait timers', async () => {
    vi.useFakeTimers();
    try {
      useRegistry(makeRegistry(makeEntry({ done: new Promise(() => {}) })));
      const pending = TaskOutputTool.execute({ task_id: 'bash-1', timeout: 0 }, ctx);
      await vi.runAllTimersAsync();
      expect(JSON.parse((await pending).content).retrieval_status).toBe('not_ready');
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('waits up to the timeout for a running command and then reports its state', async () => {
    useRegistry(makeRegistry(makeEntry({ done: new Promise(() => {}) })));

    const started = Date.now();
    const result = await TaskOutputTool.execute({ task_id: 'bash-1', timeout: 20 }, ctx);

    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    expect(JSON.parse(result.content as string).retrieval_status).toBe('not_ready');
  });
});
