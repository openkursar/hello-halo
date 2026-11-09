/**
 * Unit tests for core/conventions.ts — filesystem/env convention resolution.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  DEFAULT_CONVENTIONS,
  resolveConventions,
  resolveHome,
  userConfigDir,
} from './conventions.js';

describe('DEFAULT_CONVENTIONS', () => {
  it('prefers the vendor-neutral instruction file', () => {
    expect(DEFAULT_CONVENTIONS.memoryFiles[0]).toBe('AGENTS.md');
    expect(DEFAULT_CONVENTIONS.memoryFiles).toContain('CLAUDE.md');
  });

  it('prefers the vendor-neutral agent directory', () => {
    expect(DEFAULT_CONVENTIONS.agentDirs[0]).toBe('.agents');
    expect(DEFAULT_CONVENTIONS.agentDirs).toContain('.claude');
  });

  it('probes the neutral memory sub-directory before the compatibility one', () => {
    expect(DEFAULT_CONVENTIONS.memorySubdirs.indexOf('.agents')).toBeLessThan(
      DEFAULT_CONVENTIONS.memorySubdirs.indexOf('.claude'),
    );
  });

  it('keeps the compatibility convention for the user config directory', () => {
    expect(DEFAULT_CONVENTIONS.configDirEnv).toBe('CLAUDE_CONFIG_DIR');
    expect(DEFAULT_CONVENTIONS.userConfigDirName).toBe('.claude');
  });
});

describe('resolveConventions', () => {
  it('returns the defaults when nothing is overridden', () => {
    expect(resolveConventions()).toBe(DEFAULT_CONVENTIONS);
  });

  it('keeps unspecified fields at their defaults', () => {
    const resolved = resolveConventions({ configDirEnv: 'MY_CONFIG_DIR' });
    expect(resolved.configDirEnv).toBe('MY_CONFIG_DIR');
    expect(resolved.memoryFiles).toEqual(DEFAULT_CONVENTIONS.memoryFiles);
    expect(resolved.agentDirs).toEqual(DEFAULT_CONVENTIONS.agentDirs);
  });

  it('replaces an overridden array wholesale', () => {
    const resolved = resolveConventions({ memoryFiles: ['ONLY.md'] });
    expect(resolved.memoryFiles).toEqual(['ONLY.md']);
  });

  it('does not mutate the defaults', () => {
    resolveConventions({ agentDirs: ['changed'] });
    expect(DEFAULT_CONVENTIONS.agentDirs).toEqual(['.agents', '.claude']);
  });
});

describe('resolveHome', () => {
  it('prefers HOME', () => {
    expect(resolveHome({ HOME: '/home/a', USERPROFILE: 'C:\\b' })).toBe('/home/a');
  });

  it('falls back to USERPROFILE', () => {
    expect(resolveHome({ USERPROFILE: 'C:\\b' })).toBe('C:\\b');
  });
});

describe('userConfigDir', () => {
  it('uses the configured env var when set', () => {
    expect(userConfigDir({ CLAUDE_CONFIG_DIR: '/custom/cfg' })).toBe('/custom/cfg');
  });

  it('falls back to the default directory under home', () => {
    expect(userConfigDir({ HOME: '/home/a', CLAUDE_CONFIG_DIR: undefined })).toBe(path.join('/home/a', '.claude'));
  });

  it('follows an overridden env var name', () => {
    const conventions = resolveConventions({ configDirEnv: 'MY_CONFIG_DIR' });
    expect(userConfigDir({ MY_CONFIG_DIR: '/mine' }, conventions)).toBe('/mine');
  });

  it('follows an overridden fallback directory name', () => {
    const conventions = resolveConventions({ userConfigDirName: '.myagent' });
    expect(userConfigDir({ HOME: '/home/a', CLAUDE_CONFIG_DIR: undefined }, conventions)).toBe(
      path.join('/home/a', '.myagent'),
    );
  });
});
