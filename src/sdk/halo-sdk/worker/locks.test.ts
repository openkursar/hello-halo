import { describe, it, expect } from 'vitest';
import { LockCoordinator } from './locks.js';

describe('worker file ownership', () => {
  it('serializes conflicting owners, permits unrelated paths and releases dead owners', async () => {
    const locks = new LockCoordinator();
    const signal = new AbortController().signal;
    const a = await locks.acquire('same', 'a', signal);
    let entered = false;
    const b = locks.acquire('same', 'b', signal).then(release => { entered = true; return release; });
    const other = await locks.acquire('different', 'b', signal);
    expect(entered).toBe(false);
    locks.releaseOwner('a');
    const release = await b;
    expect(entered).toBe(true);
    a(); // A late release cannot release B's ownership.
    expect(locks.size).toBe(2);
    release(); other();
    expect(locks.size).toBe(0);
  });

  it('withdraws a cancelled waiter without taking a lock away from the current writer', async () => {
    const locks = new LockCoordinator();
    const controller = new AbortController();
    const release = await locks.acquire('file', 'writer', controller.signal);
    const waiting = new AbortController();
    const cancelled = locks.acquire('file', 'cancelled', waiting.signal);
    waiting.abort();
    await expect(cancelled).rejects.toThrow('aborted');
    expect(locks.size).toBe(1);
    release();
    expect(locks.size).toBe(0);
  });
});
