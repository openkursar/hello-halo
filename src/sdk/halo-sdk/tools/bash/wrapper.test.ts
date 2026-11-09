/**
 * @module tools/bash/wrapper.test
 * Tests for state-file wrapper construction and parsing.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWrapperScript, readStateFile } from './wrapper.js';
import type { ShellState } from '../../types/tool.js';
import { windowsPathToPosixPath } from './windows-paths.js';

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'sdk-wrap-test-'));
  tmpDirs.push(d);
  return d;
}

function makeState(cwd: string, env?: Record<string, string>): ShellState {
  const envVars = new Map<string, string>();
  if (env) for (const [k, v] of Object.entries(env)) envVars.set(k, v);
  return { cwd, envVars };
}

// ===========================================================================
// buildWrapperScript
// ===========================================================================

describe('buildWrapperScript', () => {
  it('returns script + stateFileNative + cleanup', () => {
    const dir = makeTmp();
    const sfPath = join(dir, 'state');
    const built = buildWrapperScript(
      'echo hello',
      makeState(dir),
      sfPath,
      sfPath,
    );
    expect(typeof built.script).toBe('string');
    expect(built.stateFileNative).toBe(sfPath);
    expect(typeof built.cleanup).toBe('function');
  });

  it('script restores cwd before user command', () => {
    const dir = makeTmp();
    const built = buildWrapperScript(
      'pwd',
      makeState(dir),
      join(dir, 's'),
      join(dir, 's'),
    );
    expect(built.script).toContain(`cd '${process.platform === 'win32' ? windowsPathToPosixPath(dir) : dir}'`);
    // user command appears after cd
    expect(built.script.indexOf('pwd')).toBeGreaterThan(built.script.indexOf('cd '));
  });

  it('script exports env vars before user command', () => {
    const dir = makeTmp();
    const built = buildWrapperScript(
      'echo $FOO',
      makeState(dir, { FOO: 'bar' }),
      join(dir, 's'),
      join(dir, 's'),
    );
    expect(built.script).toContain(`export FOO='bar'`);
  });

  it('script properly escapes single quotes in env values', () => {
    const dir = makeTmp();
    const built = buildWrapperScript(
      'true',
      makeState(dir, { TRICKY: "value with 'quote' inside" }),
      join(dir, 's'),
      join(dir, 's'),
    );
    expect(built.script).toContain(`'value with '"'"'quote'"'"' inside'`);
  });

  it('does NOT escape ! (no history expansion concerns)', () => {
    const dir = makeTmp();
    const built = buildWrapperScript(
      'echo "select(.x != .y)"',
      makeState(dir, { FILTER: 'select(.x != .y)' }),
      join(dir, 's'),
      join(dir, 's'),
    );
    expect(built.script).not.toContain('\\!');
  });

  it('cleanup() is idempotent and never throws', () => {
    const dir = makeTmp();
    const sfPath = join(dir, 'state');
    writeFileSync(sfPath, 'test');
    const built = buildWrapperScript('true', makeState(dir), sfPath, sfPath);
    expect(existsSync(sfPath)).toBe(true);
    built.cleanup();
    expect(existsSync(sfPath)).toBe(false);
    // Second call must not throw
    expect(() => built.cleanup()).not.toThrow();
  });
});

// ===========================================================================
// readStateFile
// ===========================================================================

describe('readStateFile', () => {
  it('returns null for missing file', () => {
    const dir = makeTmp();
    const r = readStateFile(join(dir, 'does-not-exist'));
    expect(r).toBeNull();
  });

  it('parses pwd + env correctly', () => {
    const dir = makeTmp();
    const sfPath = join(dir, 'state');
    writeFileSync(
      sfPath,
      `/c/some/path\nFOO=bar\nBAZ=qux\n`,
      'utf-8',
    );
    const r = readStateFile(sfPath);
    expect(r).not.toBeNull();
    expect(r!.cwd).toBe(process.platform === 'win32' ? 'C:\\some\\path' : '/c/some/path');
    expect(r!.envVars.get('FOO')).toBe('bar');
    expect(r!.envVars.get('BAZ')).toBe('qux');
  });

  it('filters out internal bash variables', () => {
    const dir = makeTmp();
    const sfPath = join(dir, 'state');
    writeFileSync(
      sfPath,
      `/p\nFOO=ok\nSHLVL=2\nBASH_VERSION=5.1\nPIPESTATUS=0\n_=last\nPWD=/stale\n__agent_cwd=/stale\n__agent_ec=0\nMYVAR=keep\n`,
      'utf-8',
    );
    const r = readStateFile(sfPath)!;
    expect(r.envVars.has('SHLVL')).toBe(false);
    expect(r.envVars.has('BASH_VERSION')).toBe(false);
    expect(r.envVars.has('PIPESTATUS')).toBe(false);
    expect(r.envVars.has('_')).toBe(false);
    expect(r.envVars.has('PWD')).toBe(false);
    expect(r.envVars.has('__agent_cwd')).toBe(false);
    expect(r.envVars.has('__agent_ec')).toBe(false);
    expect(r.envVars.get('FOO')).toBe('ok');
    expect(r.envVars.get('MYVAR')).toBe('keep');
  });

  it('filters BASH_FUNC_* exported functions', () => {
    const dir = makeTmp();
    const sfPath = join(dir, 'state');
    writeFileSync(
      sfPath,
      `/p\nBASH_FUNC_foo%%=() { echo bar; }\nREAL=ok\n`,
      'utf-8',
    );
    const r = readStateFile(sfPath)!;
    expect(r.envVars.has('BASH_FUNC_foo%%')).toBe(false);
    expect(r.envVars.get('REAL')).toBe('ok');
  });

  it('handles env values with embedded = signs', () => {
    const dir = makeTmp();
    const sfPath = join(dir, 'state');
    writeFileSync(
      sfPath,
      `/p\nVAR=key=value=more\n`,
      'utf-8',
    );
    const r = readStateFile(sfPath)!;
    expect(r.envVars.get('VAR')).toBe('key=value=more');
  });

  it('handles multi-line env values via continuation logic', () => {
    const dir = makeTmp();
    const sfPath = join(dir, 'state');
    writeFileSync(
      sfPath,
      `/p\nMULTILINE=line1\ncontinued\nVAR2=ok\n`,
      'utf-8',
    );
    const r = readStateFile(sfPath)!;
    expect(r.envVars.get('MULTILINE')).toBe('line1\ncontinued');
    expect(r.envVars.get('VAR2')).toBe('ok');
  });

  it('returns null on empty file', () => {
    const dir = makeTmp();
    const sfPath = join(dir, 'state');
    writeFileSync(sfPath, '', 'utf-8');
    expect(readStateFile(sfPath)).toBeNull();
  });

  it('rejects a missing cwd slot instead of scanning environment values for a path', () => {
    const dir = makeTmp();
    const sfPath = join(dir, 'state');
    writeFileSync(sfPath, '\n\n/p\nFOO=bar\n', 'utf-8');
    expect(readStateFile(sfPath)).toBeNull();
  });

  it.each(['PATH=/usr/bin', 'relative/path', 'SECRET=fixture-value'])('rejects invalid cwd %s', cwd => {
    const sfPath = join(makeTmp(), 'state');
    writeFileSync(sfPath, `${cwd}\nFOO=bar\n`, 'utf-8');
    expect(readStateFile(sfPath)).toBeNull();
  });
});
