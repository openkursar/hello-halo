import { describe, expect, it } from 'vitest';
import { ownedWindowsProcesses } from './windows-process-tree.js';

describe('Windows process ownership across MSYS exec', () => {
  it('retains replaced POSIX descendants and their native children without taking a neighbouring shell', () => {
    const native = [
      { pid: 100, parent: 10 }, { pid: 101, parent: 100 },
      { pid: 102, parent: 999 }, { pid: 103, parent: 102 },
      { pid: 200, parent: 10 }, { pid: 201, parent: 200 },
    ];
    const posix = 'PID PPID PGID WINPID TTY UID STIME COMMAND\n' +
      ' 1 0 1 101 ? 18 10:00 bash\n 2 1 1 102 ? 18 10:00 sleep\n 3 0 3 201 ? 18 10:00 bash\n';
    expect(ownedWindowsProcesses(100, native, posix).sort()).toEqual([100, 101, 102, 103]);
  });

  it('does not adopt unrelated POSIX rows when its own shell already exited', () => {
    expect(ownedWindowsProcesses(100, [], ' 2 1 1 200 ? 18 10:00 sleep\n')).toEqual([100]);
  });
});
