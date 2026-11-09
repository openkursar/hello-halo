/**
 * @module tools/task
 * Task controls for the current session's background shell processes.
 * @license MIT
 */

import type { Tool, ToolContext, ToolResult } from '../../types/tool.js';
import { toolSuccess, toolError } from '../../types/tool.js';
import { getLogger } from '../../utils/logger.js';
import {
  TASK_STOP_TOOL_NAME, TASK_STOP_DESCRIPTION, TASK_STOP_INPUT_SCHEMA,
  TASK_OUTPUT_TOOL_NAME, TASK_OUTPUT_DESCRIPTION, TASK_OUTPUT_INPUT_SCHEMA,
} from './schema.js';

const log = getLogger('TaskOutput');

export const TaskStopTool: Tool = {
  name: TASK_STOP_TOOL_NAME,
  description: TASK_STOP_DESCRIPTION,
  inputSchema: TASK_STOP_INPUT_SCHEMA as unknown as Record<string, unknown>,
  permissionLevel: 'execute',

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const taskId = input.task_id;
    if (typeof taskId !== 'string' || !taskId) return toolError('Missing required parameter: task_id');
    const shells = ctx.services?.backgroundTasks;
    const shell = shells?.get(taskId);
    const entry = shell;
    if (!entry) return toolError(`Task '${taskId}' not found`);
    if (entry.status !== 'running') return toolError(`Task '${taskId}' is not running (status: ${entry.status})`);
    if (!shells?.stop(taskId)) return toolError(`Failed to stop task '${taskId}'`);
    return toolSuccess(JSON.stringify({ message: 'Task stop requested', task_id: taskId }, null, 2));
  },
};

function waitForTask(done: Promise<void>, timeoutMs: number, signal: AbortSignal): Promise<'done' | 'timeout' | 'aborted'> {
  return new Promise((resolve, reject) => {
    const finish = (result: 'done' | 'timeout' | 'aborted'): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve(result);
    };
    const abort = (): void => finish('aborted');
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    done.then(() => finish('done'), error => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

export const TaskOutputTool: Tool = {
  name: TASK_OUTPUT_TOOL_NAME,
  description: TASK_OUTPUT_DESCRIPTION,
  inputSchema: TASK_OUTPUT_INPUT_SCHEMA as unknown as Record<string, unknown>,
  permissionLevel: 'none',

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const taskId = input.task_id;
    if (typeof taskId !== 'string' || !taskId) return toolError('Missing required parameter: task_id');
    const timeoutMs = typeof input.timeout === 'number' && Number.isFinite(input.timeout)
      ? Math.min(600_000, Math.max(0, input.timeout)) : 30_000;
    const shells = ctx.services?.backgroundTasks;
    const shell = shells?.get(taskId);
    const entry = shell;
    if (!entry) return toolError(`Task '${taskId}' not found`);

    try {
      if (input.block !== false && entry.completedAt === null) {
        const waited = await waitForTask(entry.done, timeoutMs, ctx.abortSignal);
        if (waited === 'aborted') return toolError(`Stopped waiting for task '${taskId}': request cancelled`);
      }
      const preview = await shells!.readOutput(entry);
      return toolSuccess(JSON.stringify({
        retrieval_status: entry.completedAt === null ? 'not_ready' : 'success',
        task: {
          task_id: entry.id,
          type: 'bash',
          description: entry.command,
          status: entry.status,
          result: preview.output,
          error: entry.error ?? null,
          output_file: entry.outputFile ?? null,
          truncated: preview.truncated,
          exit_code: entry.exitCode,
          started_at: new Date(entry.startedAt).toISOString(),
          ended_at: entry.completedAt
            ? new Date(entry.completedAt!).toISOString() : null,
        },
      }, null, 2));
    } catch (error) {
      log.warn('task output retrieval failed', { taskId, error: String(error) });
      return toolError(`Cannot retrieve task '${taskId}': ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};
