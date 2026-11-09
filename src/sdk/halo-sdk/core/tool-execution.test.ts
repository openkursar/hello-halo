import { describe, expect, it, vi } from 'vitest';
import { createToolExecution } from './tool-execution.js';
import { resolveQueryConfig } from './context.js';
import { CostTracker } from './cost.js';
import type { QueryConfig } from '../types/config.js';
import type { Tool } from '../types/tool.js';
import type { ToolUseBlock } from '../types/provider.js';
import type { SDKMessage, SDKResultMessage } from './query-types.js';

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}

function fixture(execute: Tool['execute'], configure?: (config: QueryConfig) => void) {
  const controller = new AbortController();
  const config = resolveQueryConfig({
    cwd: '/tmp', model: 'fixture', permissionMode: 'bypassPermissions',
    abortController: controller, toolResultBudget: 1000,
  });
  configure?.(config);
  const progress: SDKMessage[] = [];
  const denials: SDKResultMessage['permission_denials'] = [];
  const unreadableInputs = new Map<string, string>();
  const onToolMessage = vi.fn(async (_message: SDKMessage) => {});
  const emitProgress = vi.fn(async (message: SDKMessage) => { progress.push(message); });
  const tool: Tool = {
    name: 'Work', description: 'Fixture tool', permissionLevel: 'none',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    execute,
  };
  const runner = createToolExecution({
    config, tools: [tool], sessionId: 'fixture',
    toolCtx: { sessionId: 'fixture', cwd: config.cwd, abortSignal: controller.signal,
      costTracker: new CostTracker('fixture'), currentTurn: 1, env: {} },
    emitProgress, onToolMessage,
    unreadableInputs, permissionDenials: denials,
  });
  const call: ToolUseBlock = { type: 'tool_use', id: 'work-1', name: 'Work', input: { value: 'original' } };
  return { ...runner, config, call, progress, denials, controller, unreadableInputs, onToolMessage, emitProgress, tool };
}

describe('per-call execution', () => {
  it('keeps recorded model input unchanged when hooks, permissions and tools mutate nested input', async () => {
    const execute = vi.fn(async (input: Record<string, unknown>) => {
      expect(input.value).toBe('permitted');
      expect(input.nested).toEqual({ value: 'hook mutation' });
      (input.nested as Record<string, unknown>).value = 'tool mutation';
      return { content: 'Saved.', isError: false };
    });
    const runner = fixture(execute, config => {
      config.permissionMode = 'default';
      config.hooks = { PreToolUse: [{ hooks: [async input => {
        const args = (input as { tool_input: Record<string, unknown> }).tool_input;
        (args.nested as Record<string, unknown>).value = 'hook mutation';
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { value: 'hook' } } };
      }] }] };
      config.canUseTool = async (_name, input) => {
        expect(input.value).toBe('hook');
        return { behavior: 'allow', updatedInput: { value: 'permitted' } };
      };
    });
    runner.call.input.nested = { value: 'original' };
    const result = await runner.run(runner.call);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('\"value\":\"permitted\"');
    expect(runner.call.input).toEqual({ value: 'original', nested: { value: 'original' } });
    expect(execute).toHaveBeenCalledOnce();
    expect(runner.progress).toHaveLength(2);
  });

  it('does not execute after the permission callback synchronously cancels and allows', async () => {
    const execute = vi.fn(async () => ({ content: 'Unexpected.', isError: false }));
    const runner = fixture(execute);
    runner.config.permissionMode = 'default';
    runner.config.canUseTool = async () => {
      runner.controller.abort();
      return { behavior: 'allow', updatedInput: {} };
    };
    await expect(runner.run(runner.call)).rejects.toMatchObject({ name: 'AbortError' });
    expect(execute).not.toHaveBeenCalled();
    expect(runner.completedResults.size).toBe(0);
    expect(runner.progress).toHaveLength(0);
  });

  it('retains the executed result if cancellation interrupts output hooks', async () => {
    const ready = deferred();
    const runner = fixture(async () => ({ content: 'Saved.', isError: false }), config => {
      config.hooks = { PostToolUse: [{ hooks: [async () => {
        ready.resolve();
        return new Promise(() => {});
      }] }] };
    });
    const pending = runner.run(runner.call);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await ready.promise;
    runner.controller.abort();
    await rejected;
    expect(runner.completedResults.get(runner.call.id)).toEqual({
      toolUseId: runner.call.id, content: 'Saved.', isError: false, images: undefined,
    });
    expect(runner.progress).toHaveLength(2);
  });

  it('ignores a late tool result after cancellation', async () => {
    const ready = deferred();
    const release = deferred();
    const runner = fixture(async () => {
      ready.resolve();
      await release.promise;
      return { content: 'Late.', isError: false };
    });
    const rejected = expect(runner.run(runner.call)).rejects.toMatchObject({ name: 'AbortError' });
    await ready.promise;
    runner.controller.abort();
    await rejected;
    release.resolve();
    await Promise.resolve();
    expect(runner.completedResults.size).toBe(0);
  });

  it('does not invoke hooks or permissions for unreadable input', async () => {
    const execute = vi.fn(async () => ({ content: 'Unexpected.', isError: false }));
    const hook = vi.fn(async () => ({}));
    const permission = vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: {} }));
    const runner = fixture(execute, config => {
      config.permissionMode = 'default';
      config.hooks = { PreToolUse: [{ hooks: [hook] }] };
      config.canUseTool = permission;
    });
    runner.unreadableInputs.set(runner.call.id, 'Malformed tool input.');
    expect(await runner.run(runner.call)).toMatchObject({ content: 'Malformed tool input.', isError: true });
    expect(hook).not.toHaveBeenCalled();
    expect(permission).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('validates the permission-adjusted input before execution', async () => {
    const execute = vi.fn(async () => ({ content: 'Unexpected.', isError: false }));
    const runner = fixture(execute, config => {
      config.permissionMode = 'default';
      config.canUseTool = async () => ({ behavior: 'allow', updatedInput: { value: 3 } });
    });
    expect(await runner.run(runner.call)).toMatchObject({ isError: true, content: expect.stringContaining('must be string') });
    expect(execute).not.toHaveBeenCalled();
  });

  it('forwards child messages with producer backpressure', async () => {
    const ready = deferred();
    const release = deferred();
    const runner = fixture(async (_input, context) => {
      await context.onToolMessage?.({ type: 'tool_progress', tool_name: 'child', tool_use_id: 'child-1',
        parent_tool_use_id: context.toolUseId, session_id: 'child', uuid: 'child-message' });
      return { content: 'Child done.', isError: false };
    });
    runner.onToolMessage.mockImplementation(async () => { ready.resolve(); await release.promise; });
    const pending = runner.run(runner.call);
    await ready.promise;
    expect(runner.completedResults.size).toBe(0);
    release.resolve();
    expect(await pending).toMatchObject({ content: 'Child done.', isError: false });
    expect(runner.onToolMessage).toHaveBeenCalledOnce();
  });

  it('waits for progress delivery before execution and checks cancellation after delivery', async () => {
    const ready = deferred();
    const release = deferred();
    const execute = vi.fn(async () => ({ content: 'Unexpected.', isError: false }));
    const runner = fixture(execute);
    runner.emitProgress.mockImplementationOnce(async () => { ready.resolve(); await release.promise; });
    const rejected = expect(runner.run(runner.call)).rejects.toMatchObject({ name: 'AbortError' });
    await ready.promise;
    expect(execute).not.toHaveBeenCalled();
    runner.controller.abort();
    release.resolve();
    await rejected;
    expect(execute).not.toHaveBeenCalled();
    expect(runner.emitProgress).toHaveBeenCalledTimes(2);
  });

  it('prepares effective arguments without executing or announcing a running tool', async () => {
    const execute = vi.fn(async () => ({ content: 'Saved.', isError: false }));
    const permission = vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: { value: 'effective' } }));
    const runner = fixture(execute, config => { config.permissionMode = 'default'; config.canUseTool = permission; });
    const prepared = await runner.prepare(runner.call);
    expect(prepared.call.input).toEqual({ value: 'effective' });
    expect(runner.call.input).toEqual({ value: 'original' });
    expect(permission).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(runner.progress).toHaveLength(0);
    const first = prepared.run();
    const second = prepared.run();
    expect(first).toBe(second);
    expect(await first).toMatchObject({ isError: false });
    expect(execute).toHaveBeenCalledOnce();
    expect(runner.progress).toHaveLength(2);
  });

  it('does not start a prepared call cancelled while waiting for admission', async () => {
    const execute = vi.fn(async () => ({ content: 'Unexpected.', isError: false }));
    const runner = fixture(execute);
    const prepared = await runner.prepare(runner.call);
    runner.controller.abort();
    await expect(prepared.run()).rejects.toMatchObject({ name: 'AbortError' });
    expect(execute).not.toHaveBeenCalled();
    expect(runner.progress).toHaveLength(0);
  });

  it('records denials without invoking the tool', async () => {
    const execute = vi.fn(async () => ({ content: 'Unexpected.', isError: false }));
    const runner = fixture(execute, config => {
      config.permissionMode = 'default';
      config.canUseTool = async () => ({ behavior: 'deny', message: 'Not permitted.', interrupt: true });
    });
    expect(await runner.run(runner.call)).toMatchObject({ isError: true, interrupt: true });
    expect(runner.denials).toEqual([{ tool_name: 'Work', tool_use_id: 'work-1', tool_input: { value: 'original' } }]);
    expect(execute).not.toHaveBeenCalled();
  });
});
