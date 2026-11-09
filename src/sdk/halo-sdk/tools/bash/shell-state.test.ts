/**
 * Unit tests for ShellStateManager and BackgroundTaskRegistry cleanup.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ShellStateManager } from './shell-state.js';
import { BackgroundTaskRegistry } from './background.js';
import { tmpdir } from 'node:os';
import { access } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// ShellStateManager
// ---------------------------------------------------------------------------

describe('ShellStateManager', () => {
  let mgr: ShellStateManager;

  beforeEach(() => {
    mgr = new ShellStateManager();
  });

  it('creates a fresh state on first access', () => {
    const state = mgr.get('session-1', '/home/user');
    expect(state.cwd).toBe('/home/user');
    expect(state.envVars.size).toBe(0);
  });

  it('returns the same state object on subsequent gets', () => {
    const s1 = mgr.get('session-1', '/home/user');
    s1.cwd = '/tmp';
    const s2 = mgr.get('session-1', '/home/user');
    expect(s2.cwd).toBe('/tmp');
  });

  it('isolates state by sessionId', () => {
    const a = mgr.get('session-a', '/home/a');
    const b = mgr.get('session-b', '/home/b');
    a.cwd = '/home/a/changed';
    expect(b.cwd).toBe('/home/b');
  });

  it('keeps shell working state isolated by session identity', () => {
    mgr.get('source-session', '/home').cwd = '/source';
    mgr.get('other-session', '/home').cwd = '/other';

    expect(mgr.get('source-session', '/home').cwd).toBe('/source');
    expect(mgr.get('other-session', '/home').cwd).toBe('/other');
  });

  it('remove releases the entry so nothing accumulates', () => {
    mgr.get('session-1', '/home').cwd = '/changed';
    expect(mgr.size).toBe(1);

    mgr.remove('session-1');

    expect(mgr.size).toBe(0);
    expect(mgr.get('session-1', '/default').cwd).toBe('/default');
  });

  it('remove leaves other sessions untouched', () => {
    mgr.get('session-1', '/home').cwd = '/one';
    mgr.get('session-2', '/home').cwd = '/two';

    mgr.remove('session-1');

    expect(mgr.get('session-2', '/home').cwd).toBe('/two');
  });

  it('remove is idempotent', () => {
    mgr.get('session-x', '/home');
    mgr.remove('session-x');
    expect(() => mgr.remove('session-x')).not.toThrow();
  });
});

describe('BackgroundTaskRegistry', () => {
  function start(registry: BackgroundTaskRegistry, command: string) {
    return registry.start({
      command, state: { cwd: tmpdir(), envVars: new Map() }, env: {},
      timeoutMs: 60_000, abortSignal: new AbortController().signal,
    });
  }

  it('evicts old completed entries without evicting running tasks or output files', async () => {
    const registry = new BackgroundTaskRegistry();
    try {
      const running = await start(registry, 'sleep 60');
      const first = await start(registry, 'true');
      await first.done;
      let last = first;
      for (let i = 0; i < 8; i++) {
        const batch = await Promise.all(Array.from({ length: 16 }, () => start(registry, 'true')));
        await Promise.all(batch.map(task => task.done));
        last = batch[batch.length - 1];
      }
      expect(registry.get(first.id)).toBeUndefined();
      expect(registry.get(running.id)?.status).toBe('running');
      expect(registry.get(last.id)?.status).toBe('completed');
      expect(registry.getAll()).toHaveLength(129);
      await expect(access(first.outputFile)).resolves.toBeUndefined();
    } finally {
      registry.dispose();
      await registry.flush();
    }
  }, 30_000);

  it('disposal stops tasks and removes temporary output', async () => {
    const registry = new BackgroundTaskRegistry();
    const task = await start(registry, 'sleep 60');
    registry.dispose();
    await registry.flush();
    expect(task.status).toBe('stopped');
    expect(registry.getAll()).toEqual([]);
    await expect(access(task.outputFile)).rejects.toThrow();
  });

  it('keeps one session shutdown from clearing another session', async () => {
    const first = new BackgroundTaskRegistry();
    const second = new BackgroundTaskRegistry();
    try {
      const task = await start(second, 'true');
      await task.done;
      first.dispose();
      await first.flush();
      expect(second.get(task.id)?.status).toBe('completed');
    } finally {
      second.dispose();
      await second.flush();
    }
  });
});
