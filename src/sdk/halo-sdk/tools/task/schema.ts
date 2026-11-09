/**
 * @module tools/task/schema
 * TaskStop / TaskOutput tool schemas.
 * @license MIT
 */

// ---------------------------------------------------------------------------
// TaskStop
// ---------------------------------------------------------------------------

export const TASK_STOP_TOOL_NAME = 'TaskStop';
export const TASK_STOP_DESCRIPTION =
  'Stop a background Bash command in the current session, identified by the task_id returned when it was started.';
export const TASK_STOP_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    task_id: { type: 'string', description: 'ID of the background Bash command to stop' },
  },
  required: ['task_id'],
} as const;

// ---------------------------------------------------------------------------
// TaskOutput
// ---------------------------------------------------------------------------

export const TASK_OUTPUT_TOOL_NAME = 'TaskOutput';
export const TASK_OUTPUT_DESCRIPTION =
  'Read the status and bounded output of a background Bash command in this session by task_id. By default waits for it to finish (up to the timeout); pass block=false to check without waiting. Use Read on output_file for additional output.';
export const TASK_OUTPUT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    task_id: { type: 'string', description: 'Task ID to get output for' },
    block: {
      type: 'boolean',
      description: 'Whether to wait for completion (default true)',
    },
    timeout: {
      type: 'number',
      description:
        'Max wait time in ms when block=true (0–600000, default: 30000). Returns not_ready if exceeded.',
      minimum: 0,
      maximum: 600000,
    },
  },
  required: ['task_id'],
} as const;
