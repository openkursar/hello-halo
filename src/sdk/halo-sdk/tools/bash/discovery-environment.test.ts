import { afterEach, describe, expect, it, vi } from 'vitest';
import { findSuitableShell } from './find-shell.js';

const { paths } = vi.hoisted(() => ({ paths: new Set(['C:\\first\\bash.exe', 'D:\\portable\\bash.exe']) }));
vi.mock('./platform.js', () => ({ isWindows: () => true }));
vi.mock('./which.js', () => ({ whichSync: () => null }));
vi.mock('node:fs', async original => ({
  ...await original<object>(),
  existsSync: (path: string) => paths.has(path),
  accessSync: (path: string) => { if (!paths.has(path)) throw new Error('Not found'); },
}));
afterEach(() => vi.unstubAllEnvs());

describe('Windows shell discovery environment', () => {
  it('uses the session Git Bash path instead of a process-global first selection', () => {
    vi.stubEnv('AGENT_GIT_BASH_PATH', 'C:\\first\\bash.exe');
    expect(findSuitableShell({ AGENT_GIT_BASH_PATH: 'C:\\first\\bash.exe' })).toBe('C:\\first\\bash.exe');
    expect(findSuitableShell({ AGENT_GIT_BASH_PATH: 'D:\\portable\\bash.exe' })).toBe('D:\\portable\\bash.exe');
  });

  it('honours an explicit session shell before Git Bash discovery', () => {
    expect(findSuitableShell({ AGENT_SHELL: 'D:\\portable\\bash.exe', AGENT_GIT_BASH_PATH: 'C:\\first\\bash.exe' }))
      .toBe('D:\\portable\\bash.exe');
  });
});
