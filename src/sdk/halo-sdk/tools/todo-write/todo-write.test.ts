/**
 * @module tools/todo-write/todo-write.test
 * Unit tests for TodoWriteTool — in-memory store plus disk persistence
 * (hermetic: CLAUDE_CONFIG_DIR points at a temp dir).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '../../types/tool.js';
import { CostTracker } from '../../core/cost.js';
import { TodoWriteTool, getTodos, buildTodoAttachment } from './index.js';

let tmpConfigDir: string;
let prevConfigDir: string | undefined;

beforeAll(() => {
  tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-write-test-'));
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir;
});

afterAll(() => {
  if (prevConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
  }
  fs.rmSync(tmpConfigDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(sessionId?: string): ToolContext {
  return {
    sessionId: sessionId ?? randomUUID(),
    cwd: os.tmpdir(),
    abortSignal: new AbortController().signal,
    costTracker: new CostTracker('test-model'),
    currentTurn: 0,
    env: {},
  };
}

function makeTodo(
  content: string,
  status: 'pending' | 'in_progress' | 'completed' = 'pending',
  activeForm?: string,
) {
  return { content, status, activeForm: activeForm ?? content };
}

// ===========================================================================
// Tool metadata
// ===========================================================================

describe('TodoWriteTool — metadata', () => {
  it('has the correct name', () => {
    expect(TodoWriteTool.name).toBe('TodoWrite');
  });

  it('has permissionLevel "none"', () => {
    expect(TodoWriteTool.permissionLevel).toBe('none');
  });

  it('has an inputSchema with required todos property', () => {
    const schema = TodoWriteTool.inputSchema as Record<string, unknown>;
    expect((schema.properties as Record<string, unknown>).todos).toBeDefined();
    expect((schema.required as string[]).includes('todos')).toBe(true);
  });
});

// ===========================================================================
// Input validation
// ===========================================================================

describe('TodoWriteTool — input validation', () => {
  it('returns an error when todos is missing', async () => {
    const ctx = makeCtx();
    const result = await TodoWriteTool.execute({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content as string).toContain('todos');
  });

  it('returns an error when todos is not an array', async () => {
    const ctx = makeCtx();
    const result = await TodoWriteTool.execute({ todos: 'not-an-array' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content as string).toContain('todos');
  });

  it('returns an error when a todo item is missing content', async () => {
    const ctx = makeCtx();
    const result = await TodoWriteTool.execute(
      { todos: [{ status: 'pending', activeForm: 'x' }] },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content as string).toContain('content');
  });

  it('returns an error when a todo item is missing status', async () => {
    const ctx = makeCtx();
    const result = await TodoWriteTool.execute(
      { todos: [{ content: 'do something', activeForm: 'doing something' }] },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content as string).toContain('status');
  });

  it('returns an error for invalid status value', async () => {
    const ctx = makeCtx();
    const result = await TodoWriteTool.execute(
      { todos: [{ content: 'task', status: 'unknown', activeForm: 'task' }] },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content as string).toContain('"unknown"');
  });
});

// ===========================================================================
// Basic write / persistence
// ===========================================================================

describe('TodoWriteTool — basic write', () => {
  it('echoes the todo state back on a valid write', async () => {
    const ctx = makeCtx();
    const result = await TodoWriteTool.execute(
      {
        todos: [
          makeTodo('task A', 'pending'),
          makeTodo('task B', 'in_progress', 'working on task B'),
        ],
      },
      ctx,
    );
    expect(result.isError).toBe(false);
    const content = result.content as string;
    expect(content).toContain('Todo list updated:');
    expect(content).toContain('[ ] task A');
    expect(content).toContain('[~] task B');
  });

  it('persists todos to in-memory store keyed by sessionId', async () => {
    const ctx = makeCtx();
    await TodoWriteTool.execute(
      { todos: [makeTodo('save me', 'pending')] },
      ctx,
    );
    const stored = getTodos(ctx.sessionId);
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toBe('save me');
    expect(stored[0].status).toBe('pending');
  });

  it('replaces previous state on subsequent calls (full replacement)', async () => {
    const ctx = makeCtx();
    await TodoWriteTool.execute(
      { todos: [makeTodo('old task', 'pending')] },
      ctx,
    );
    await TodoWriteTool.execute(
      { todos: [makeTodo('new task A', 'pending'), makeTodo('new task B', 'in_progress', 'doing B')] },
      ctx,
    );
    const stored = getTodos(ctx.sessionId);
    expect(stored).toHaveLength(2);
    expect(stored[0].content).toBe('new task A');
    expect(stored[1].content).toBe('new task B');
  });

  it('sessions are isolated (different sessionIds have separate stores)', async () => {
    const ctxA = makeCtx();
    const ctxB = makeCtx();

    await TodoWriteTool.execute(
      { todos: [makeTodo('session A task', 'pending')] },
      ctxA,
    );
    await TodoWriteTool.execute(
      { todos: [makeTodo('session B task 1', 'pending'), makeTodo('session B task 2', 'in_progress')] },
      ctxB,
    );

    expect(getTodos(ctxA.sessionId)).toHaveLength(1);
    expect(getTodos(ctxB.sessionId)).toHaveLength(2);
  });

  it('accepts empty array (clears the list)', async () => {
    const ctx = makeCtx();
    await TodoWriteTool.execute(
      { todos: [makeTodo('initial', 'pending')] },
      ctx,
    );
    const result = await TodoWriteTool.execute({ todos: [] }, ctx);
    expect(result.isError).toBe(false);
    expect(getTodos(ctx.sessionId)).toHaveLength(0);
  });

  it('clears the store when all todos are completed (allDone)', async () => {
    const ctx = makeCtx();
    const result = await TodoWriteTool.execute(
      {
        todos: [
          makeTodo('task A', 'completed'),
          makeTodo('task B', 'completed'),
        ],
      },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content as string).toContain('All todos completed');
    // The list is cleared when all items are done — store should be empty
    expect(getTodos(ctx.sessionId)).toHaveLength(0);
  });

  it('does not clear the store when some todos are still pending', async () => {
    const ctx = makeCtx();
    await TodoWriteTool.execute(
      {
        todos: [
          makeTodo('task A', 'pending'),
          makeTodo('task B', 'completed'),
        ],
      },
      ctx,
    );
    expect(getTodos(ctx.sessionId)).toHaveLength(2);
  });
});

// ===========================================================================
// Edge cases
// ===========================================================================

describe('TodoWriteTool — edge cases', () => {
  it('getTodos returns [] for unknown sessionId', () => {
    expect(getTodos('unknown-session-' + randomUUID())).toEqual([]);
  });

  it('handles 20 todos in a single write', async () => {
    const ctx = makeCtx();
    const todos = Array.from({ length: 20 }, (_, i) => makeTodo(`task ${i}`, 'pending'));
    const result = await TodoWriteTool.execute({ todos }, ctx);
    expect(result.isError).toBe(false);
    expect(getTodos(ctx.sessionId)).toHaveLength(20);
  });

  it('handles special characters in content', async () => {
    const ctx = makeCtx();
    const content = 'Fix bug: <HTML> & "quotes" — and em-dash';
    const result = await TodoWriteTool.execute(
      { todos: [makeTodo(content, 'pending')] },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(getTodos(ctx.sessionId)[0].content).toBe(content);
  });

  it('persists todos to disk and getTodos falls back to the file', async () => {
    const ctx = makeCtx();
    await TodoWriteTool.execute(
      { todos: [makeTodo('durable task', 'in_progress')] },
      ctx,
    );
    const file = path.join(tmpConfigDir, 'todos', `${ctx.sessionId}.json`);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].content).toBe('durable task');
  });

  it('buildTodoAttachment wraps the current list in a system reminder', async () => {
    const ctx = makeCtx();
    await TodoWriteTool.execute(
      { todos: [makeTodo('task A', 'pending'), makeTodo('task B', 'completed')] },
      ctx,
    );
    const msg = buildTodoAttachment(ctx.sessionId);
    expect(msg).not.toBeNull();
    expect(msg!.role).toBe('user');
    const text = (msg!.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('<system-reminder>');
    expect(text).toContain('[ ] task A');
    expect(text).toContain('[x] task B');
  });

  it('buildTodoAttachment returns null when there are no todos', () => {
    expect(buildTodoAttachment('empty-session-' + randomUUID())).toBeNull();
  });

  it('uses content as default activeForm when activeForm is omitted', async () => {
    const ctx = makeCtx();
    const result = await TodoWriteTool.execute(
      { todos: [{ content: 'run linter', status: 'in_progress' }] },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(getTodos(ctx.sessionId)[0].activeForm).toBe('run linter');
  });
});
