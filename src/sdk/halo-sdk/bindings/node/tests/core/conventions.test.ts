import { describe, expect, it } from 'vitest';
import { resolveQueryConfig } from '../../index.js';
import type { Options } from '../../types/config.js';

const resolve = (conventions?: Options['conventions']) => resolveQueryConfig({ model: 'fixture', conventions }).conventions;

describe('filesystem conventions through public configuration', () => {
  it('prefers vendor-neutral instructions and retains compatibility', () => {
    expect(resolve().memoryFiles[0]).toBe('AGENTS.md');
    expect(resolve().memoryFiles).toContain('CLAUDE.md');
  });

  it('prefers the vendor-neutral agent directory and retains compatibility', () => {
    expect(resolve().agentDirs[0]).toBe('.agents');
    expect(resolve().agentDirs).toContain('.claude');
  });

  it('probes the neutral memory directory before the compatibility directory', () => {
    const conventions = resolve();
    expect(conventions.memorySubdirs.indexOf('.agents')).toBeLessThan(conventions.memorySubdirs.indexOf('.claude'));
  });

  it('retains the compatibility user config directory by default', () => {
    expect(resolve().configDirEnv).toBe('CLAUDE_CONFIG_DIR');
    expect(resolve().userConfigDirName).toBe('.claude');
  });

  it('resolves the same default values when overrides are omitted', () => {
    expect(resolve()).toEqual(resolve({}));
  });

  it('keeps unspecified fields at their defaults', () => {
    const conventions = resolve({ configDirEnv: 'MY_CONFIG_DIR' });
    expect(conventions.configDirEnv).toBe('MY_CONFIG_DIR');
    expect(conventions.memoryFiles).toEqual(resolve().memoryFiles);
    expect(conventions.agentDirs).toEqual(resolve().agentDirs);
  });

  it('replaces an overridden array wholesale', () => {
    expect(resolve({ memoryFiles: ['ONLY.md'] }).memoryFiles).toEqual(['ONLY.md']);
  });

  it('does not mutate defaults', () => {
    resolve({ agentDirs: ['changed'] });
    expect(resolve().agentDirs).toEqual(['.agents', '.claude']);
  });
});
