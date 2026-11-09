import { describe, expect, it } from 'vitest';
import { ripgrepCommand, ripgrepEnvironment } from './environment.js';

describe('ripgrep session environment', () => {
  it('inherits process values while isolating overrides and explicit removals', () => {
    const inherited = { PATH: '/system/bin', SHARED: 'inherited', REMOVE: 'remove' };
    const overrides = { PATH: '/session/bin', REMOVE: undefined };
    const env = ripgrepEnvironment(overrides, inherited, 'linux');
    expect(env).toEqual({ PATH: '/session/bin', SHARED: 'inherited', REMOVE: undefined });
    env.SHARED = 'changed';
    expect(inherited.SHARED).toBe('inherited');
    expect(overrides.PATH).toBe('/session/bin');
  });

  it('collapses Windows environment names so a session Path overrides inherited PATH', () => {
    const env = ripgrepEnvironment({ Path: 'C:\\session bin', agent_ripgrep_path: 'C:\\host tools\\rg.exe', SystemRoot: 'C:\\Windows' },
      { PATH: 'C:\\system bin', SYSTEMROOT: 'D:\\Windows' }, 'win32');
    expect(env).toEqual({ PATH: 'C:\\session bin', AGENT_RIPGREP_PATH: 'C:\\host tools\\rg.exe', SYSTEMROOT: 'C:\\Windows' });
    expect(ripgrepCommand(env, 'win32')).toBe('C:\\host tools\\rg.exe');
  });

  it('respects case-sensitive POSIX names and rejects relative overrides', () => {
    const env = ripgrepEnvironment({ Path: '/other', agent_ripgrep_path: '/other/rg' }, { PATH: '/bin' }, 'linux');
    expect(env.PATH).toBe('/bin');
    expect(env.Path).toBe('/other');
    expect(ripgrepCommand(env, 'linux')).toBe('rg');
    expect(ripgrepCommand({ AGENT_RIPGREP_PATH: 'relative/rg' }, 'linux')).toBe('rg');
    expect(ripgrepCommand({ AGENT_RIPGREP_PATH: 'C:relative\\rg.exe' }, 'win32')).toBe('rg');
    expect(ripgrepCommand({ AGENT_RIPGREP_PATH: '\\\\server\\tools\\rg.exe' }, 'win32')).toBe('\\\\server\\tools\\rg.exe');
  });
});
