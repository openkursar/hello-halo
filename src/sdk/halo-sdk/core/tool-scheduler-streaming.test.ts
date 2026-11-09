import { describe, expect, it, vi } from 'vitest';
import type { Tool } from '../types/tool.js';
import { createToolScheduler } from './tool-scheduler.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const tools = [
  { name: 'Read', isConcurrencySafe: () => true },
  { name: 'Write' },
] as Tool[];
const call = (id: number, name = 'Read') => ({ name, input: {}, id });
type Call = ReturnType<typeof call>;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function harness(maxConcurrency = 2, signal?: AbortSignal) {
  const started: number[] = [];
  const pending = new Map<number, ReturnType<typeof deferred<number>>>();
  const scheduler = createToolScheduler<Call, number>(tools, entry => {
    started.push(entry.id);
    const completion = deferred<number>();
    pending.set(entry.id, completion);
    return completion.promise;
  }, { maxConcurrency, signal });
  const finish = (id: number) => pending.get(id)!.resolve(id);
  return { scheduler, started, pending, finish };
}

describe('streaming tool scheduler', () => {
  it('executes complete calls before the producer finishes and joins new safe calls', async () => {
    const { scheduler, started, finish } = harness();
    scheduler.enqueue(call(0));
    expect(started).toEqual([0]);
    await flush();
    scheduler.enqueue(call(1));
    expect(started).toEqual([0, 1]);
    let completed = false;
    void scheduler.done.then(() => { completed = true; });
    finish(1);
    finish(0);
    await flush();
    expect(completed).toBe(false);
    expect(await scheduler.finish()).toEqual([0, 1]);
  });

  it('fills available capacity without waiting for an earlier safe call', async () => {
    const { scheduler, started, finish } = harness();
    for (let id = 0; id < 4; id++) scheduler.enqueue(call(id));
    expect(started).toEqual([0, 1]);
    finish(1);
    await flush();
    expect(started).toEqual([0, 1, 2]);
    finish(2);
    await flush();
    expect(started).toEqual([0, 1, 2, 3]);
    finish(3);
    finish(0);
    expect(await scheduler.finish()).toEqual([0, 1, 2, 3]);
  });

  it('does not let a later read bypass a waiting exclusive call', async () => {
    const { scheduler, started, finish } = harness(3);
    scheduler.enqueue(call(0));
    scheduler.enqueue(call(1));
    scheduler.enqueue(call(2, 'Write'));
    scheduler.enqueue(call(3));
    finish(1);
    await flush();
    expect(started).toEqual([0, 1]);
    finish(0);
    await flush();
    expect(started).toEqual([0, 1, 2]);
    scheduler.enqueue(call(4));
    expect(started).toEqual([0, 1, 2]);
    finish(2);
    await flush();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    finish(4);
    finish(3);
    expect(await scheduler.finish()).toEqual([0, 1, 2, 3, 4]);
  });

  it('preserves an exclusive barrier when the stream pauses with an empty queue', async () => {
    const { scheduler, started, finish } = harness();
    scheduler.enqueue(call(0, 'Write'));
    await flush();
    scheduler.enqueue(call(1));
    expect(started).toEqual([0]);
    finish(0);
    await flush();
    expect(started).toEqual([0, 1]);
    finish(1);
    expect(await scheduler.finish()).toEqual([0, 1]);
  });

  it('stops queued work on failure, waits for running work and retains the first error', async () => {
    const { scheduler, started, pending, finish } = harness();
    scheduler.enqueue(call(0));
    scheduler.enqueue(call(1));
    scheduler.enqueue(call(2, 'Write'));
    const failure = new Error('runner failed');
    pending.get(0)!.reject(failure);
    await flush();
    let completed = false;
    void scheduler.done.catch(() => { completed = true; });
    scheduler.stop(new Error('later stop'));
    expect(() => scheduler.enqueue(call(3))).toThrow(failure);
    expect(started).toEqual([0, 1]);
    expect(completed).toBe(false);
    finish(1);
    await expect(scheduler.finish()).rejects.toBe(failure);
    expect(completed).toBe(true);
  });

  it('closes the producer on abort but waits for its active runner to settle', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const { scheduler, started, finish } = harness(1, controller.signal);
    scheduler.enqueue(call(0));
    scheduler.enqueue(call(1));
    const reason = new Error('cancelled');
    controller.abort(reason);
    let completed = false;
    void scheduler.done.catch(() => { completed = true; });
    await flush();
    expect(started).toEqual([0]);
    expect(completed).toBe(false);
    finish(0);
    await expect(scheduler.finish()).rejects.toBe(reason);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('never starts work for an already aborted turn', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn();
    const scheduler = createToolScheduler(tools, run, { signal: controller.signal });
    expect(() => scheduler.enqueue(call(0))).toThrow();
    await expect(scheduler.finish()).rejects.toHaveProperty('name', 'AbortError');
    expect(run).not.toHaveBeenCalled();
  });

  it('handles synchronous runner failure without losing a rejection', async () => {
    const failure = new Error('synchronous failure');
    const scheduler = createToolScheduler(tools, () => { throw failure; });
    scheduler.enqueue(call(0));
    await flush();
    await expect(scheduler.finish()).rejects.toBe(failure);
  });

  it('closes empty producers, removes listeners, and rejects late enqueues', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const scheduler = createToolScheduler(tools, async () => 'unused', { signal: controller.signal });
    expect(await scheduler.finish()).toEqual([]);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(() => scheduler.enqueue(call(0))).toThrow('closed');
    scheduler.stop(new Error('too late'));
    expect(await scheduler.done).toEqual([]);
  });

  it('keeps independent schedulers independent even while exclusive calls run', async () => {
    const first = harness();
    const second = harness();
    first.scheduler.enqueue(call(0, 'Write'));
    second.scheduler.enqueue(call(1, 'Write'));
    expect(first.started).toEqual([0]);
    expect(second.started).toEqual([1]);
    first.finish(0);
    second.finish(1);
    expect(await Promise.all([first.scheduler.finish(), second.scheduler.finish()])).toEqual([[0], [1]]);
  });
});

describe('prepared tool scheduling', () => {
  it('classifies effective inputs after preparation while allowing safe work to overlap', async () => {
    const started: number[] = [];
    const prepared: number[] = [];
    const releases = [deferred<number>(), deferred<number>(), deferred<number>()];
    const effectiveTools = [{ name: 'Dynamic', isConcurrencySafe: (input: Record<string, unknown>) => input.read === true }] as Tool[];
    const scheduler = createToolScheduler<Call, number>(effectiveTools, async () => { throw new Error('Unexpected raw execution'); }, {
      canPrepareConcurrently: true,
      prepare: async entry => {
        prepared.push(entry.id);
        return {
          call: { ...entry, input: { read: entry.id !== 2 } },
          run: async () => { started.push(entry.id); return releases[entry.id].promise; },
        };
      },
    });
    scheduler.enqueue(call(0, 'Dynamic'));
    scheduler.enqueue(call(1, 'Dynamic'));
    scheduler.enqueue(call(2, 'Dynamic'));
    await flush();
    expect(prepared).toEqual([0, 1, 2]);
    expect(started).toEqual([0, 1]);
    releases[0].resolve(0);
    await flush();
    expect(started).toEqual([0, 1]);
    releases[1].resolve(1);
    await flush();
    expect(started).toEqual([0, 1, 2]);
    releases[2].resolve(2);
    expect(await scheduler.finish()).toEqual([0, 1, 2]);
  });

  it('holds preparation behind an active exclusive call and keeps asynchronous preparation ordered', async () => {
    const started: number[] = [];
    const prepared: number[] = [];
    const permission = deferred();
    const exclusive = deferred<number>();
    const scheduler = createToolScheduler<Call, number>(tools, async () => 0, {
      canPrepareConcurrently: true,
      prepare: async entry => {
        prepared.push(entry.id);
        if (entry.id === 0) await permission.promise;
        return { call: entry, run: async () => {
          started.push(entry.id);
          return entry.id === 0 ? exclusive.promise : entry.id;
        } };
      },
    });
    scheduler.enqueue(call(0, 'Write'));
    scheduler.enqueue(call(1));
    await flush();
    expect(prepared).toEqual([0]);
    expect(started).toEqual([]);
    permission.resolve();
    await flush();
    expect(prepared).toEqual([0]);
    expect(started).toEqual([0]);
    exclusive.resolve(0);
    expect(await scheduler.finish()).toEqual([0, 1]);
    expect(prepared).toEqual([0, 1]);
  });

  it('serializes effectful preparation against active safe tools', async () => {
    const prepared: number[] = [];
    const release = deferred<number>();
    const scheduler = createToolScheduler<Call, number>(tools, async () => 0, {
      prepare: async entry => {
        prepared.push(entry.id);
        return { call: entry, run: async () => entry.id === 0 ? release.promise : entry.id };
      },
    });
    scheduler.enqueue(call(0));
    scheduler.enqueue(call(1));
    await flush();
    expect(prepared).toEqual([0]);
    release.resolve(0);
    expect(await scheduler.finish()).toEqual([0, 1]);
    expect(prepared).toEqual([0, 1]);
  });

  it('announces the first failure before active work settles so the owner can cancel it', async () => {
    const failure = new Error('runner failed');
    const first = deferred<number>();
    const sibling = deferred<number>();
    let failureCalls = 0;
    const scheduler = createToolScheduler<Call, number>(tools, entry => entry.id === 0 ? first.promise : sibling.promise, {
      onFailure: reason => {
        expect(reason).toBe(failure);
        failureCalls++;
        sibling.resolve(1);
      },
    });
    scheduler.enqueue(call(0));
    scheduler.enqueue(call(1));
    first.reject(failure);
    await expect(scheduler.finish()).rejects.toBe(failure);
    expect(failureCalls).toBe(1);
  });

  it('aborts an active preparation without starting it or the next queued call', async () => {
    const controller = new AbortController();
    const permission = deferred();
    const run = vi.fn(async () => 0);
    const prepare = vi.fn(async (entry: Call) => {
      await permission.promise;
      return { call: entry, run };
    });
    const scheduler = createToolScheduler(tools, run, {
      signal: controller.signal,
      prepare,
      onFailure: () => permission.resolve(),
    });
    scheduler.enqueue(call(0));
    scheduler.enqueue(call(1));
    await flush();
    controller.abort();
    await expect(scheduler.finish()).rejects.toHaveProperty('name', 'AbortError');
    expect(prepare).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it('does not prepare after cancellation between enqueue and its preparation microtask', async () => {
    const prepare = vi.fn(async (entry: Call) => ({ call: entry, run: async () => 0 }));
    const scheduler = createToolScheduler(tools, async () => 0, { prepare });
    scheduler.enqueue(call(0));
    const reason = new Error('consumer closed');
    scheduler.stop(reason);
    await expect(scheduler.finish()).rejects.toBe(reason);
    expect(prepare).not.toHaveBeenCalled();
  });
});
