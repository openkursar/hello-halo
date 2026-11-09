/**
 * Unit tests for prompt/memory.ts — project instruction file loading.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadProjectMemory } from './memory.js';
import { DEFAULT_CONVENTIONS } from '../core/conventions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp directory tree and return its root path. */
function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-memory-test-'));
}

/** Write a file, creating parent dirs as needed. */
function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

/** Recursively remove a directory. */
function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadProjectMemory', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTmpDir();
  });

  afterEach(() => {
    rmDir(tmpRoot);
  });

  // ── Empty / no files ───────────────────────────────────────────────────

  it('returns undefined when no memory files exist', () => {
    const cwd = path.join(tmpRoot, 'project');
    fs.mkdirSync(cwd, { recursive: true });

    const result = loadProjectMemory(cwd, { HOME: tmpRoot }, ['project']);
    expect(result).toBeUndefined();
  });

  it('returns undefined when settingSources is empty', () => {
    const cwd = path.join(tmpRoot, 'project');
    writeFile(path.join(cwd, 'CLAUDE.md'), 'some rules');

    const result = loadProjectMemory(cwd, { HOME: tmpRoot }, []);
    expect(result).toBeUndefined();
  });

  // ── Project-level files ────────────────────────────────────────────────

  it('loads CLAUDE.md from cwd when settingSources includes project', () => {
    const cwd = path.join(tmpRoot, 'project');
    writeFile(path.join(cwd, 'CLAUDE.md'), 'project rules');

    const result = loadProjectMemory(cwd, { HOME: tmpRoot }, ['project']);
    expect(result).toBe('project rules');
  });

  it('loads AGENTS.md from cwd as fallback', () => {
    const cwd = path.join(tmpRoot, 'project');
    writeFile(path.join(cwd, 'AGENTS.md'), 'agent rules');

    const result = loadProjectMemory(cwd, { HOME: tmpRoot }, ['project']);
    expect(result).toBe('agent rules');
  });

  it('loads CLAUDE.md from .claude subdirectory', () => {
    const cwd = path.join(tmpRoot, 'project');
    writeFile(path.join(cwd, '.claude', 'CLAUDE.md'), 'dot-claude rules');

    const result = loadProjectMemory(cwd, { HOME: tmpRoot }, ['project']);
    expect(result).toBe('dot-claude rules');
  });

  it('concatenates multiple files found in the same directory', () => {
    const cwd = path.join(tmpRoot, 'project');
    writeFile(path.join(cwd, 'CLAUDE.md'), 'root rules');
    writeFile(path.join(cwd, '.claude', 'CLAUDE.md'), 'dot-claude rules');

    const result = loadProjectMemory(cwd, { HOME: tmpRoot }, ['project']);
    expect(result).toContain('root rules');
    expect(result).toContain('dot-claude rules');
  });

  it('walks up ancestor directories', () => {
    // Structure: tmpRoot/parent/child — CLAUDE.md at both levels
    const parent = path.join(tmpRoot, 'parent');
    const child = path.join(parent, 'child');
    fs.mkdirSync(child, { recursive: true });
    writeFile(path.join(parent, 'CLAUDE.md'), 'parent rules');
    writeFile(path.join(child, 'CLAUDE.md'), 'child rules');

    const result = loadProjectMemory(child, { HOME: tmpRoot }, ['project']);
    expect(result).toContain('child rules');
    expect(result).toContain('parent rules');
  });

  it('stops walking at home directory', () => {
    // Files above home should NOT be loaded
    const home = path.join(tmpRoot, 'home');
    const aboveHome = tmpRoot; // parent of home
    const cwd = path.join(home, 'project');
    fs.mkdirSync(cwd, { recursive: true });
    writeFile(path.join(aboveHome, 'CLAUDE.md'), 'above-home rules');
    writeFile(path.join(cwd, 'CLAUDE.md'), 'project rules');

    const result = loadProjectMemory(cwd, { HOME: home }, ['project']);
    // Should find project rules (in cwd)
    expect(result).toContain('project rules');
    // Should NOT include above-home rules (above stop point)
    expect(result).not.toContain('above-home rules');
  });

  it('deduplicates files — same path is not included twice', () => {
    const cwd = path.join(tmpRoot, 'project');
    writeFile(path.join(cwd, 'CLAUDE.md'), 'rules here');

    // Call with both 'project' and 'local' — should not double-include
    const result = loadProjectMemory(cwd, { HOME: tmpRoot }, ['project', 'local']);
    const count = (result ?? '').split('rules here').length - 1;
    expect(count).toBe(1);
  });

  // ── User-level files ───────────────────────────────────────────────────

  it('loads user-level CLAUDE.md from ~/.claude when settingSources includes user', () => {
    const home = path.join(tmpRoot, 'home');
    writeFile(path.join(home, '.claude', 'CLAUDE.md'), 'user rules');

    const cwd = path.join(tmpRoot, 'project');
    fs.mkdirSync(cwd, { recursive: true });

    const result = loadProjectMemory(cwd, { HOME: home }, ['user']);
    expect(result).toBe('user rules');
  });

  it('loads CLAUDE_CONFIG_DIR CLAUDE.md when env is set', () => {
    const configDir = path.join(tmpRoot, 'config');
    writeFile(path.join(configDir, 'CLAUDE.md'), 'config-dir rules');

    const cwd = path.join(tmpRoot, 'project');
    fs.mkdirSync(cwd, { recursive: true });

    const result = loadProjectMemory(
      cwd,
      { HOME: tmpRoot, CLAUDE_CONFIG_DIR: configDir },
      ['user'],
    );
    expect(result).toBe('config-dir rules');
  });

  it('combines user and project sources', () => {
    const home = path.join(tmpRoot, 'home');
    writeFile(path.join(home, '.claude', 'CLAUDE.md'), 'user rules');

    const cwd = path.join(home, 'project');
    writeFile(path.join(cwd, 'CLAUDE.md'), 'project rules');

    const result = loadProjectMemory(cwd, { HOME: home }, ['user', 'project']);
    expect(result).toContain('user rules');
    expect(result).toContain('project rules');
  });

  it('ignores source "local" identically to "project"', () => {
    const cwd = path.join(tmpRoot, 'project');
    writeFile(path.join(cwd, 'CLAUDE.md'), 'local rules');

    const result = loadProjectMemory(cwd, { HOME: tmpRoot }, ['local']);
    expect(result).toBe('local rules');
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  it('skips empty CLAUDE.md files', () => {
    const cwd = path.join(tmpRoot, 'project');
    writeFile(path.join(cwd, 'CLAUDE.md'), '   '); // whitespace only

    const result = loadProjectMemory(cwd, { HOME: tmpRoot }, ['project']);
    expect(result).toBeUndefined();
  });

  it('trims leading/trailing whitespace from file content', () => {
    const cwd = path.join(tmpRoot, 'project');
    writeFile(path.join(cwd, 'CLAUDE.md'), '\n\n  rules here  \n\n');

    const result = loadProjectMemory(cwd, { HOME: tmpRoot }, ['project']);
    expect(result).toBe('rules here');
  });

  it('falls back to os.homedir() when HOME env is not set', () => {
    // Should not throw even when HOME is undefined
    const cwd = path.join(tmpRoot, 'project');
    fs.mkdirSync(cwd, { recursive: true });

    expect(() =>
      loadProjectMemory(cwd, {}, ['project']),
    ).not.toThrow();
  });

  it('handles cwd that does not exist without throwing', () => {
    const cwd = path.join(tmpRoot, 'nonexistent', 'deep', 'path');
    expect(() =>
      loadProjectMemory(cwd, { HOME: tmpRoot }, ['project']),
    ).not.toThrow();
  });

  it('does not load project files when settingSources is user-only', () => {
    const cwd = path.join(tmpRoot, 'project');
    writeFile(path.join(cwd, 'CLAUDE.md'), 'project rules');

    // user settingSources but no user files exist
    const result = loadProjectMemory(cwd, { HOME: tmpRoot }, ['user']);
    expect(result).toBeUndefined();
  });

  it('does not load user files when settingSources is project-only', () => {
    const home = path.join(tmpRoot, 'home');
    writeFile(path.join(home, '.claude', 'CLAUDE.md'), 'user rules');

    const cwd = path.join(tmpRoot, 'project');
    fs.mkdirSync(cwd, { recursive: true });

    const result = loadProjectMemory(cwd, { HOME: home }, ['project']);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Vendor-neutral convention support
// ---------------------------------------------------------------------------

describe('loadProjectMemory — .agents convention', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTmpDir();
  });

  afterEach(() => {
    rmDir(tmpRoot);
  });

  it('loads AGENTS.md from the project root', () => {
    const cwd = path.join(tmpRoot, 'project');
    writeFile(path.join(cwd, 'AGENTS.md'), 'neutral rules');

    expect(loadProjectMemory(cwd, { HOME: tmpRoot }, ['project'])).toBe('neutral rules');
  });

  it('loads AGENTS.md from the .agents sub-directory', () => {
    const cwd = path.join(tmpRoot, 'project');
    writeFile(path.join(cwd, '.agents', 'AGENTS.md'), 'from .agents');

    expect(loadProjectMemory(cwd, { HOME: tmpRoot }, ['project'])).toBe('from .agents');
  });

  it('lists AGENTS.md before CLAUDE.md in the concatenated output', () => {
    const cwd = path.join(tmpRoot, 'project');
    writeFile(path.join(cwd, 'AGENTS.md'), 'neutral');
    writeFile(path.join(cwd, 'CLAUDE.md'), 'compat');

    const result = loadProjectMemory(cwd, { HOME: tmpRoot }, ['project']);
    expect(result!.indexOf('neutral')).toBeLessThan(result!.indexOf('compat'));
  });

  it('reads a symlinked directory once, not twice', () => {
    const cwd = path.join(tmpRoot, 'project');
    writeFile(path.join(cwd, '.agents', 'AGENTS.md'), 'shared rules');
    fs.symlinkSync(path.join(cwd, '.agents'), path.join(cwd, '.claude'));

    const result = loadProjectMemory(cwd, { HOME: tmpRoot }, ['project']);
    // Probing both `.agents/` and `.claude/` must not duplicate the content.
    expect(result).toBe('shared rules');
  });

  it('reads a symlinked file once, not twice', () => {
    const cwd = path.join(tmpRoot, 'project');
    writeFile(path.join(cwd, 'AGENTS.md'), 'shared rules');
    fs.symlinkSync(path.join(cwd, 'AGENTS.md'), path.join(cwd, 'CLAUDE.md'));

    const result = loadProjectMemory(cwd, { HOME: tmpRoot }, ['project']);
    expect(result).toBe('shared rules');
  });

  it('honours a conventions override for file names and sub-directories', () => {
    const cwd = path.join(tmpRoot, 'project');
    writeFile(path.join(cwd, '.myagent', 'RULES.md'), 'custom rules');

    const result = loadProjectMemory(cwd, { HOME: tmpRoot }, ['project'], {
      conventions: {
        ...DEFAULT_CONVENTIONS,
        memoryFiles: ['RULES.md'],
        memorySubdirs: ['', '.myagent'],
      },
    });
    expect(result).toBe('custom rules');
  });

  it('honours a conventions override for the user config directory', () => {
    const home = path.join(tmpRoot, 'home');
    writeFile(path.join(home, '.myagent', 'AGENTS.md'), 'custom user rules');

    const result = loadProjectMemory(
      path.join(tmpRoot, 'empty'),
      { HOME: home },
      ['user'],
      { conventions: { ...DEFAULT_CONVENTIONS, userConfigDirName: '.myagent' } },
    );
    expect(result).toBe('custom user rules');
  });
});
