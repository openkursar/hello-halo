/**
 * @module tools/todo-write
 * TodoWriteTool — write and manage a todo/task list.
 *
 * The list is working memory: it is echoed back in the tool result (so the
 * current plan sits at the context tail every time it changes) and persisted
 * to disk so it survives process restarts and context compaction.
 * @license MIT
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Message } from '../../types/provider.js';
import type { Tool, ToolContext, ToolResult } from '../../types/tool.js';
import { toolSuccess, toolError } from '../../types/tool.js';
import { buildSystemReminderMessage } from '../../utils/system-reminder.js';
import { sessionStoragePath } from '../session-storage.js';
import {
  TODO_WRITE_TOOL_NAME,
  TODO_WRITE_TOOL_DESCRIPTION,
  TODO_WRITE_TOOL_INPUT_SCHEMA,
} from './schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm: string;
}

// ---------------------------------------------------------------------------
// Store — in-memory cache backed by a per-session JSON file
// ---------------------------------------------------------------------------

const todoStore = new Map<string, TodoItem[]>();

/** Write todos to disk. Advisory — a failed write never breaks the tool. */
function persistTodos(sessionId: string, todos: TodoItem[]): void {
  const file = sessionStoragePath(sessionId, 'todos');
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(todos, null, 2), 'utf-8');
  } catch (error) {
    console.warn(`[Todo] Persistence failed: session=${sessionId}`, error);
  }
}

function readTodosFromDisk(sessionId: string): TodoItem[] | null {
  const file = sessionStoragePath(sessionId, 'todos');
  if (!file) return null;
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TodoItem[]) : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[Todo] Stored list could not be read: session=${sessionId} reason=${error instanceof Error ? error.name : 'unknown'} code=${(error as NodeJS.ErrnoException).code ?? '-'}`);
    return null;
  }
}

export function captureTodos(sessionId: string): TodoItem[] | undefined {
  return todoStore.get(sessionId)?.map(todo => ({ ...todo }));
}

export function restoreTodos(sessionId: string, todos: readonly TodoItem[] | undefined): void {
  if (!todos) return;
  const restored = todos.map(todo => ({ ...todo }));
  todoStore.set(sessionId, restored);
  persistTodos(sessionId, restored);
}

/** Get the stored todos for a session (falls back to the on-disk copy). */
export function getTodos(sessionId: string): TodoItem[] {
  const cached = todoStore.get(sessionId);
  if (cached) return cached;
  const fromDisk = readTodosFromDisk(sessionId);
  if (fromDisk) {
    todoStore.set(sessionId, fromDisk);
    return fromDisk;
  }
  return [];
}

/**
 * Forget a session's todos.
 *
 * The in-memory entry is always dropped. `discardPersisted` also removes the
 * on-disk copy. Resumable session owners retain the file; disposable queries
 * discard their private working state.
 */
export function releaseTodos(
  sessionId: string,
  options: { discardPersisted?: boolean } = {},
): void {
  todoStore.delete(sessionId);
  if (!options.discardPersisted) return;
  const file = sessionStoragePath(sessionId, 'todos');
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch (error) {
    console.warn(`[Todo] Stored list could not be removed: session=${sessionId}`, error);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const STATUS_MARKERS: Record<TodoStatus, string> = {
  completed: '[x]',
  in_progress: '[~]',
  pending: '[ ]',
};

function renderTodoList(todos: TodoItem[]): string {
  return todos
    .map((t) => `${STATUS_MARKERS[t.status]} ${t.content}`)
    .join('\n');
}

/**
 * Build a system-reminder Message carrying the current todo list, for
 * re-injection at the context tail (e.g. after compaction). Returns null
 * when the session has no todos.
 */
export function buildTodoAttachment(sessionId: string): Message | null {
  const todos = getTodos(sessionId);
  if (todos.length === 0) return null;
  return buildSystemReminderMessage(
    `# Current todo list (working memory — survives context compaction)\n${renderTodoList(todos)}`,
  );
}

// ---------------------------------------------------------------------------
// Status validation
// ---------------------------------------------------------------------------

const VALID_STATUSES = new Set<string>(['pending', 'in_progress', 'completed']);

// ---------------------------------------------------------------------------
// TodoWriteTool
// ---------------------------------------------------------------------------

export const TodoWriteTool: Tool = {
  name: TODO_WRITE_TOOL_NAME,
  description: TODO_WRITE_TOOL_DESCRIPTION,
  inputSchema: TODO_WRITE_TOOL_INPUT_SCHEMA as unknown as Record<string, unknown>,
  permissionLevel: 'none',

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const rawTodos = input.todos;
    if (!Array.isArray(rawTodos)) {
      return toolError('Missing required parameter: todos (must be an array)');
    }

    // Parse and validate
    const todos: TodoItem[] = [];
    for (const item of rawTodos) {
      const obj = item as Record<string, unknown>;
      const content = obj.content as string;
      const status = obj.status as string;
      const activeForm = obj.activeForm as string;

      if (!content || !status) {
        return toolError('Each todo must have content and status fields.');
      }
      if (!VALID_STATUSES.has(status)) {
        return toolError(
          `Invalid status "${status}": must be one of "pending", "in_progress", or "completed".`,
        );
      }

      todos.push({
        content,
        status: status as TodoStatus,
        activeForm: activeForm || content,
      });
    }

    const allDone = todos.every(t => t.status === 'completed');
    const newTodos = allDone ? [] : todos;

    todoStore.set(ctx.sessionId, newTodos);
    persistTodos(ctx.sessionId, newTodos);

    // Echo the list back so the current plan sits at the context tail —
    // the model re-reads its own goals right after every update.
    if (allDone) {
      return toolSuccess('All todos completed — list cleared.');
    }
    return toolSuccess(
      `Todo list updated:\n${renderTodoList(newTodos)}\n\nContinue to keep this list current as work progresses.`,
    );
  },
};
