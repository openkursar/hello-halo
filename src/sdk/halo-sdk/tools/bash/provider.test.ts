import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareShellCommand, resolveShellPath, shellEnvironment } from './provider.js';
import { findSuitableShell } from './find-shell.js';

vi.mock('./find-shell.js', () => ({ findSuitableShell: vi.fn(env => env.AGENT_SHELL ?? env.AGENT_GIT_BASH_PATH ?? env.SHELL) }));

beforeEach(() => { vi.mocked(findSuitableShell).mockClear(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('session shell selection', () => {
  it('separates session choices and reuses paths without repeated discovery', () => {
    expect(resolveShellPath({ AGENT_SHELL: '/session-a/bash' })).toBe('/session-a/bash');
    expect(resolveShellPath({ AGENT_SHELL: '/session-b/bash' })).toBe('/session-b/bash');
    expect(resolveShellPath({ AGENT_SHELL: '/session-a/bash' })).toBe('/session-a/bash');
    expect(findSuitableShell).toHaveBeenCalledTimes(2);
  });

  it('keeps unrelated session credentials out of the selection key and cached value', () => {
    const first = resolveShellPath({ AGENT_SHELL: '/shared/bash', MODEL_API_KEY: 'first-fixture' });
    expect(resolveShellPath({ AGENT_SHELL: '/shared/bash', MODEL_API_KEY: 'second-fixture' })).toBe(first);
    expect(typeof first).toBe('string');
    expect(findSuitableShell).toHaveBeenCalledTimes(1);
  });

  it('evicts old paths instead of retaining every environment ever used', () => {
    resolveShellPath({ AGENT_SHELL: '/evicted/bash' });
    for (let i = 0; i < 100; i++) resolveShellPath({ AGENT_SHELL: `/other-${i}/bash` });
    resolveShellPath({ AGENT_SHELL: '/evicted/bash' });
    expect(findSuitableShell).toHaveBeenCalledTimes(102);
  });

  it('treats an explicit undefined override as removing the process selection', () => {
    vi.stubEnv('AGENT_SHELL', '/process/bash');
    expect(resolveShellPath({ SHELL: '/fallback/zsh' })).toBe('/process/bash');
    expect(resolveShellPath({ AGENT_SHELL: undefined, SHELL: '/fallback/zsh' })).toBe('/fallback/zsh');
    expect(findSuitableShell).toHaveBeenLastCalledWith(expect.objectContaining({ AGENT_SHELL: undefined }));
  });
});

describe('shared launch preparation', () => {
  it('keeps invocation arguments, output pipes and state tracking intact', () => {
    const state = { cwd: process.cwd(), envVars: new Map([['SDK_FIXTURE', 'first']]) };
    const launch = prepareShellCommand('/bin/bash', 'printf value >nul', state, 'launch-fixture');
    try {
      expect(launch.executable).toBe('/bin/bash');
      expect(launch.args[0]).toBe('-c');
      expect(launch.args).toHaveLength(2);
      expect(launch.args[1]).toContain('printf value >/dev/null');
      expect(launch.args[1]).toContain('SDK_FIXTURE');
      expect(launch.options).toEqual({
        cwd: state.cwd, stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32', windowsHide: true,
      });
      expect(launch.stateFile).toMatch(/sdk-bash-launch-fixture\.state$/);
      expect(state.envVars.get('SDK_FIXTURE')).toBe('first');
    } finally {
      launch.cleanup();
      launch.cleanup();
    }
  });

  it('samples the current process environment and gives caller overrides precedence', () => {
    vi.stubEnv('LANG', '');
    vi.stubEnv('LC_ALL', '');
    vi.stubEnv('SDK_ENV_FIXTURE', 'before');
    const first = shellEnvironment();
    expect(first).toMatchObject({ LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8', AGENT_MODE: '1', GIT_EDITOR: 'true' });
    vi.stubEnv('SDK_ENV_FIXTURE', 'after');
    expect(shellEnvironment()).toHaveProperty('SDK_ENV_FIXTURE', 'after');
    expect(first).toHaveProperty('SDK_ENV_FIXTURE', 'before');
    expect(shellEnvironment({ LANG: 'caller', GIT_EDITOR: 'custom', AGENT_MODE: undefined }))
      .toMatchObject({ LANG: 'caller', LC_ALL: 'C.UTF-8', GIT_EDITOR: 'custom', AGENT_MODE: undefined });
  });

  it('does not introduce locale defaults when the process already declares one', () => {
    vi.stubEnv('LANG', 'en_US.UTF-8');
    vi.stubEnv('LC_ALL', '');
    expect(shellEnvironment()).toMatchObject({ LANG: 'en_US.UTF-8', LC_ALL: '' });
  });
});
