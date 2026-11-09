/**
 * Unit tests for the per-turn tool scheduler.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_TOOL_CONCURRENCY,
  partitionToolCalls,
  resolveMaxToolConcurrency,
  runToolBatches,
} from './tool-scheduler.js';
import type { Tool } from '../types/tool.js';

function makeTool(name: string, concurrencySafe?: boolean | (() => never)): Tool {
  return {
    name,
    description: name,
    inputSchema: {},
    permissionLevel: 'none',
    ...(concurrencySafe === undefined
      ? {}
      : {
          isConcurrencySafe:
            typeof concurrencySafe === 'function'
              ? concurrencySafe
              : () => concurrencySafe,
        }),
    async execute() {
      return { content: '', isError: false };
    },
  } as Tool;
}

const TOOLS: Tool[] = [
  makeTool('Read', true),
  makeTool('Grep', true),
  makeTool('Write'),
  makeTool('Bash'),
];

function call(name: string): { name: string; input: Record<string, unknown> } {
  return { name, input: {} };
}

/**
 * Run the given call names, recording how many calls are in flight at each
 * moment so tests can assert what actually overlapped.
 */
async function runTracked(
  names: string[],
  tools: Tool[] = TOOLS,
  maxConcurrency?: number,
): Promise<{ order: string[]; overlaps: Map<string, number> }> {
  const order: string[] = [];
  const overlaps = new Map<string, number>();
  let inFlight = 0;

  await runToolBatches(
    names.map(call),
    tools,
    async (c) => {
      inFlight++;
      overlaps.set(c.name, Math.max(overlaps.get(c.name) ?? 0, inFlight));
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      order.push(c.name);
      return c.name;
    },
    maxConcurrency,
  );

  return { order, overlaps };
}

describe('partitionToolCalls', () => {
  it('groups adjacent safe calls and isolates unsafe ones', () => {
    const batches = partitionToolCalls(
      ['Read', 'Grep', 'Write', 'Read'].map(call),
      TOOLS,
    );

    expect(batches.map((b) => [b.concurrencySafe, b.calls.length])).toEqual([
      [true, 2],
      [false, 1],
      [true, 1],
    ]);
  });

  it('treats a tool that declares nothing as unsafe', () => {
    const batches = partitionToolCalls(['Write', 'Bash'].map(call), TOOLS);
    expect(batches).toHaveLength(2);
    expect(batches.every((b) => !b.concurrencySafe)).toBe(true);
  });

  it('treats an unknown tool as unsafe', () => {
    const batches = partitionToolCalls([call('NoSuchTool')], TOOLS);
    expect(batches[0].concurrencySafe).toBe(false);
  });

  it('treats a call as unsafe when the check itself throws', () => {
    const tools = [makeTool('Flaky', () => { throw new Error('cannot tell'); })];
    const batches = partitionToolCalls([call('Flaky')], tools);
    expect(batches[0].concurrencySafe).toBe(false);
  });
});

describe('runToolBatches', () => {
  it('returns results in the order the model asked for them', async () => {
    const results = await runToolBatches(
      ['Read', 'Write', 'Grep'].map(call),
      TOOLS,
      async (c) => c.name,
    );

    expect(results).toEqual(['Read', 'Write', 'Grep']);
  });

  it('overlaps safe calls', async () => {
    const { overlaps } = await runTracked(['Read', 'Read', 'Grep']);
    expect(overlaps.get('Read')).toBeGreaterThan(1);
  });

  it('never overlaps an unsafe call with anything', async () => {
    const { overlaps } = await runTracked(['Read', 'Write', 'Read', 'Bash']);
    expect(overlaps.get('Write')).toBe(1);
    expect(overlaps.get('Bash')).toBe(1);
  });

  it('finishes everything before an unsafe call starts', async () => {
    const { order } = await runTracked(['Read', 'Grep', 'Write']);
    expect(order).toEqual(['Read', 'Grep', 'Write']);
  });

  it('honours the concurrency cap', async () => {
    const names = Array.from({ length: 12 }, () => 'Read');
    const { overlaps } = await runTracked(names, TOOLS, 3);
    expect(overlaps.get('Read')).toBeLessThanOrEqual(3);
  });

  it('runs a single safe call without waiting on a pool', async () => {
    const results = await runToolBatches([call('Read')], TOOLS, async (c) => c.name);
    expect(results).toEqual(['Read']);
  });

  it('keeps turns independent across sessions', async () => {
    // Serialising unsafe calls is scoped to one turn: a write in one session
    // must not block a write in another, or a host running hundreds would grind.
    let live = 0;
    let bothLive = false;
    const release: Array<() => void> = [];

    const turn = (): Promise<unknown[]> =>
      runToolBatches(
        [call('Write')],
        TOOLS,
        async () => {
          live++;
          if (live > 1) bothLive = true;
          await new Promise<void>((resolve) => release.push(resolve));
          live--;
          return null;
        },
      );

    const turns = Promise.all([turn(), turn()]);
    // Let both turns reach their tool call before letting either finish.
    await new Promise((resolve) => setTimeout(resolve, 0));
    release.forEach((resolve) => resolve());
    await turns;

    expect(bothLive).toBe(true);
  });

  it('waits for started calls to settle after failure and does not start queued work', async () => {
    const started: number[] = [];
    let fail!: () => void;
    let release!: () => void;
    const failing = new Promise<void>(resolve => { fail = resolve; });
    const running = new Promise<void>(resolve => { release = resolve; });
    let settled = false;
    const task = runToolBatches([0, 1, 2].map(index => ({ name: 'Read', input: { index } })), TOOLS, async entry => {
      const index = entry.input.index;
      started.push(index);
      if (index === 0) { await failing; throw new Error('failed'); }
      await running;
      return index;
    }, 2);
    const rejected = expect(task).rejects.toThrow('failed');
    void task.finally(() => { settled = true; }).catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    fail();
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(started).toEqual([0, 1]);
    release();
    await rejected;
    expect(settled).toBe(true);
  });

  it('refuses invalid concurrency instead of silently running no tools', async () => {
    for (const limit of [0, -1, NaN, 1.5]) {
      await expect(runToolBatches([call('Read')], TOOLS, async () => 'result', limit)).rejects.toThrow(RangeError);
    }
  });

});

describe('resolveMaxToolConcurrency', () => {
  it('defaults when unset', () => {
    expect(resolveMaxToolConcurrency({})).toBe(DEFAULT_MAX_TOOL_CONCURRENCY);
  });

  it('reads a positive override', () => {
    expect(resolveMaxToolConcurrency({ HALO_MAX_TOOL_CONCURRENCY: '4' })).toBe(4);
  });

  it('ignores values that are not a positive integer', () => {
    for (const value of ['0', '-2', 'many', '', '1.5', '4workers', 'Infinity', '9007199254740992']) {
      expect(resolveMaxToolConcurrency({ HALO_MAX_TOOL_CONCURRENCY: value })).toBe(
        DEFAULT_MAX_TOOL_CONCURRENCY,
      );
    }
  });
});
