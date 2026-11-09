import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const fixture = vi.hoisted(() => ({ child: undefined as unknown }));
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: () => fixture.child };
});
import { spawn, killProcessTree } from './processes.js';

afterEach(() => { vi.restoreAllMocks(); });

describe.skipIf(process.platform === 'win32')('POSIX spawn cancellation', () => {
  it('reapplies an early group stop when spawn confirms the process group exists', async () => {
    fixture.child = Object.assign(new EventEmitter(), { pid: 4242, spawnfile: '/bin/sh' });
    const kill = vi.spyOn(process, 'kill').mockImplementation(pid => {
      if (pid === -4242 && kill.mock.calls.length === 1) throw Object.assign(new Error('Group not ready'), { code: 'ESRCH' });
      return true;
    });
    const child = spawn('/bin/sh');
    await killProcessTree(4242, 'SIGKILL');
    expect(kill.mock.calls).toEqual([[-4242, 'SIGKILL'], [4242, 'SIGKILL']]);
    child.emit('spawn');
    expect(kill.mock.calls.at(-1)).toEqual([-4242, 'SIGKILL']);
    expect(kill).toHaveBeenCalledTimes(3);
    child.emit('spawn');
    expect(kill).toHaveBeenCalledTimes(3);
    child.emit('close');
  });

  it('terminates a descendant that joins the group while its parent is being killed', async () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    fixture.child = Object.assign(new EventEmitter(), { pid: 4250, spawnfile: '/bin/sh' });
    const child = spawn('/bin/sh');
    child.emit('spawn');
    await killProcessTree(4250, 'SIGKILL');
    child.emit('exit');
    expect(kill.mock.calls).toEqual([[-4250, 'SIGKILL'], [-4250, 'SIGKILL']]);
    kill.mockImplementation(() => { throw Object.assign(new Error('Group gone'), { code: 'ESRCH' }); });
    await killProcessTree(4250, 'SIGKILL');
    expect(kill.mock.calls.at(-1)).toEqual([-4250, 'SIGKILL']);
    expect(kill.mock.calls.some(([pid]) => pid === 4250)).toBe(false);
    child.emit('close');
  });

  it('never retries a closed owner or downgrades an already requested forced stop', async () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    fixture.child = Object.assign(new EventEmitter(), { pid: 4243, spawnfile: '/bin/sh' });
    const first = spawn('/bin/sh');
    await killProcessTree(4243, 'SIGKILL');
    await killProcessTree(4243, 'SIGTERM');
    first.emit('spawn');
    expect(kill.mock.calls.at(-1)).toEqual([-4243, 'SIGKILL']);
    first.emit('close');
    fixture.child = Object.assign(new EventEmitter(), { pid: 4244, spawnfile: '/bin/sh' });
    const closed = spawn('/bin/sh');
    await killProcessTree(4244, 'SIGKILL');
    closed.emit('close');
    const count = kill.mock.calls.length;
    closed.emit('spawn');
    expect(kill).toHaveBeenCalledTimes(count);
  });
});
