/**
 * @module tools/goal/goal.test
 * Unit tests for GoalTool and the goal store — actions, host edits, the
 * seen-by-model record, and disk persistence (hermetic: CLAUDE_CONFIG_DIR
 * points at a temp dir).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '../../types/tool.js';
import { CostTracker } from '../../core/cost.js';
import {
  GoalTool,
  drainGoalChange,
  getActiveGoal,
  getGoal,
  releaseGoal,
  setGoalFromHost,
} from './index.js';

let tmpConfigDir: string;
let prevConfigDir: string | undefined;

beforeAll(() => {
  tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-test-'));
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

function makeCtx(sessionId = randomUUID()): ToolContext {
  return {
    sessionId,
    cwd: os.tmpdir(),
    abortSignal: new AbortController().signal,
    costTracker: new CostTracker('test-model'),
    currentTurn: 0,
    env: {},
  };
}

function goalFile(sessionId: string): string {
  return path.join(tmpConfigDir, 'goals', `${sessionId}.json`);
}

describe('GoalTool — metadata', () => {
  it('is named Goal and needs no permission', () => {
    expect(GoalTool.name).toBe('Goal');
    expect(GoalTool.permissionLevel).toBe('none');
  });

  it('describes when to use it with examples', () => {
    expect(GoalTool.description).toContain('When to use it');
    expect(GoalTool.description).toContain('<example>');
  });
});

describe('GoalTool — actions', () => {
  it('sets a goal and echoes it', async () => {
    const ctx = makeCtx();
    const result = await GoalTool.execute(
      { action: 'set', objective: '  Migrate to TypeScript ', doneWhen: ['tsc passes', '  ', 'tests pass'] },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Objective: Migrate to TypeScript');
    const goal = getGoal(ctx.sessionId)!;
    expect(goal.objective).toBe('Migrate to TypeScript');
    expect(goal.doneWhen).toEqual(['tsc passes', 'tests pass']);
    expect(goal.status).toBe('active');
    expect(goal.updatedBy).toBe('agent');
  });

  it('rejects set without an objective', async () => {
    const result = await GoalTool.execute({ action: 'set', objective: '   ' }, makeCtx());
    expect(result.isError).toBe(true);
  });

  it('notes the goal it replaced', async () => {
    const ctx = makeCtx();
    await GoalTool.execute({ action: 'set', objective: 'First' }, ctx);
    const result = await GoalTool.execute({ action: 'set', objective: 'Second' }, ctx);
    expect(result.content).toContain('Replaced the previous goal: First');
    expect(getGoal(ctx.sessionId)!.objective).toBe('Second');
  });

  it('updates only the fields provided', async () => {
    const ctx = makeCtx();
    await GoalTool.execute({ action: 'set', objective: 'Ship', doneWhen: ['a'] }, ctx);

    await GoalTool.execute({ action: 'update', doneWhen: ['a', 'b'] }, ctx);
    expect(getGoal(ctx.sessionId)).toMatchObject({ objective: 'Ship', doneWhen: ['a', 'b'] });

    await GoalTool.execute({ action: 'update', objective: 'Ship v2' }, ctx);
    expect(getGoal(ctx.sessionId)).toMatchObject({ objective: 'Ship v2', doneWhen: ['a', 'b'] });
  });

  it('completes and abandons only an active goal', async () => {
    const ctx = makeCtx();
    expect((await GoalTool.execute({ action: 'complete' }, ctx)).isError).toBe(true);
    expect((await GoalTool.execute({ action: 'update', objective: 'x' }, ctx)).isError).toBe(true);

    await GoalTool.execute({ action: 'set', objective: 'Ship' }, ctx);
    const done = await GoalTool.execute({ action: 'complete', note: 'all criteria verified' }, ctx);
    expect(done.isError).toBe(false);
    expect(getGoal(ctx.sessionId)).toMatchObject({ status: 'complete', note: 'all criteria verified' });
    expect(getActiveGoal(ctx.sessionId)).toBeNull();

    expect((await GoalTool.execute({ action: 'abandon' }, ctx)).isError).toBe(true);
  });

  it('abandons an active goal', async () => {
    const ctx = makeCtx();
    await GoalTool.execute({ action: 'set', objective: 'Ship' }, ctx);
    await GoalTool.execute({ action: 'abandon', note: 'user cancelled' }, ctx);
    expect(getGoal(ctx.sessionId)!.status).toBe('abandoned');
  });

  it('rejects an unknown action', async () => {
    const result = await GoalTool.execute({ action: 'delete' }, makeCtx());
    expect(result.isError).toBe(true);
  });
});

describe('goal store — host edits', () => {
  it('reports a host change to the model exactly once', () => {
    const sessionId = randomUUID();
    setGoalFromHost(sessionId, { objective: 'Launch copy ready', doneWhen: ['Headline written'] });

    const change = drainGoalChange(sessionId);
    expect(change?.previous).toBeNull();
    expect(change?.current).toMatchObject({ objective: 'Launch copy ready', updatedBy: 'user' });
    expect(drainGoalChange(sessionId)).toBeNull();
  });

  it('does not report changes the model made itself', async () => {
    const ctx = makeCtx();
    await GoalTool.execute({ action: 'set', objective: 'Ship' }, ctx);
    expect(drainGoalChange(ctx.sessionId)).toBeNull();
  });

  it('reports nothing when the host reverts its own edit before the next turn', async () => {
    const ctx = makeCtx();
    await GoalTool.execute({ action: 'set', objective: 'Ship', doneWhen: ['a'] }, ctx);

    setGoalFromHost(ctx.sessionId, { objective: 'Something else' });
    setGoalFromHost(ctx.sessionId, { objective: 'Ship', doneWhen: ['a'] });

    expect(drainGoalChange(ctx.sessionId)).toBeNull();
  });

  it('reports a removal', async () => {
    const ctx = makeCtx();
    await GoalTool.execute({ action: 'set', objective: 'Ship' }, ctx);
    setGoalFromHost(ctx.sessionId, null);

    const change = drainGoalChange(ctx.sessionId);
    expect(change?.previous?.objective).toBe('Ship');
    expect(change?.current).toBeNull();
    expect(getGoal(ctx.sessionId)).toBeNull();
  });

  it('rejects a blank objective from the host', () => {
    expect(() => setGoalFromHost(randomUUID(), { objective: '  ' })).toThrow(TypeError);
  });
});

describe('goal store — persistence', () => {
  it('survives a release and reloads as already seen by the model', async () => {
    const ctx = makeCtx();
    await GoalTool.execute({ action: 'set', objective: 'Ship', doneWhen: ['a'] }, ctx);
    expect(fs.existsSync(goalFile(ctx.sessionId))).toBe(true);

    releaseGoal(ctx.sessionId);

    expect(getGoal(ctx.sessionId)).toMatchObject({ objective: 'Ship', doneWhen: ['a'] });
    expect(drainGoalChange(ctx.sessionId)).toBeNull();
  });

  it('deletes the file once a cleared goal has been drained', async () => {
    const ctx = makeCtx();
    await GoalTool.execute({ action: 'set', objective: 'Ship' }, ctx);
    setGoalFromHost(ctx.sessionId, null);
    expect(fs.existsSync(goalFile(ctx.sessionId))).toBe(true);

    drainGoalChange(ctx.sessionId);
    expect(fs.existsSync(goalFile(ctx.sessionId))).toBe(false);
  });

  it('still tells the model about a clear made before the session was rebuilt', async () => {
    const ctx = makeCtx();
    await GoalTool.execute({ action: 'set', objective: 'Ship', doneWhen: ['a'] }, ctx);
    setGoalFromHost(ctx.sessionId, null);

    releaseGoal(ctx.sessionId);

    expect(getGoal(ctx.sessionId)).toBeNull();
    const change = drainGoalChange(ctx.sessionId);
    expect(change?.current).toBeNull();
    expect(change?.previous).toMatchObject({ objective: 'Ship', doneWhen: ['a'] });
    expect(drainGoalChange(ctx.sessionId)).toBeNull();
  });

  it('still tells the model about a replacement made before the session was rebuilt', async () => {
    const ctx = makeCtx();
    await GoalTool.execute({ action: 'set', objective: 'Ship' }, ctx);
    setGoalFromHost(ctx.sessionId, { objective: 'Ship v2' });

    releaseGoal(ctx.sessionId);

    const change = drainGoalChange(ctx.sessionId);
    expect(change?.previous).toMatchObject({ objective: 'Ship' });
    expect(change?.current).toMatchObject({ objective: 'Ship v2' });
    releaseGoal(ctx.sessionId);
    expect(drainGoalChange(ctx.sessionId)).toBeNull();
  });

  it('reads an older file holding the bare goal as already seen', () => {
    const sessionId = randomUUID();
    fs.mkdirSync(path.dirname(goalFile(sessionId)), { recursive: true });
    fs.writeFileSync(
      goalFile(sessionId),
      JSON.stringify({ objective: 'Legacy', doneWhen: [], status: 'active', updatedBy: 'agent', updatedAt: '2026-01-01T00:00:00Z' }),
      'utf-8',
    );
    expect(getGoal(sessionId)).toMatchObject({ objective: 'Legacy' });
    expect(drainGoalChange(sessionId)).toBeNull();
  });

  it('discards the persisted goal on request', async () => {
    const ctx = makeCtx();
    await GoalTool.execute({ action: 'set', objective: 'Ship' }, ctx);
    releaseGoal(ctx.sessionId, { discardPersisted: true });
    expect(fs.existsSync(goalFile(ctx.sessionId))).toBe(false);
    expect(getGoal(ctx.sessionId)).toBeNull();
  });

  it('ignores a corrupt goal file', () => {
    const sessionId = randomUUID();
    fs.mkdirSync(path.dirname(goalFile(sessionId)), { recursive: true });
    fs.writeFileSync(goalFile(sessionId), '{"objective": 42}', 'utf-8');
    expect(getGoal(sessionId)).toBeNull();
  });
});
