/**
 * @module tools/file-tools.test
 * Unit tests for ReadTool, WriteTool, EditTool, and GlobTool.
 * Uses real temp-directory I/O to validate behaviour end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FileReadState, ToolContext } from '../types/tool.js';
import { ReadTool } from './read/index.js';
import { WriteTool } from './write/index.js';
import { EditTool } from './edit/index.js';
import { GlobTool } from './glob/index.js';
import { CostTracker } from '../core/cost.js';
import * as fileAccess from './file-access.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeCtx(cwd: string): ToolContext {
  return {
    sessionId: 'test-session',
    cwd,
    abortSignal: new AbortController().signal,
    costTracker: new CostTracker('test-model'),
    currentTurn: 0,
    env: {},
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-file-tools-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// ReadTool
// ===========================================================================

describe('ReadTool — input validation', () => {
  const tool = new ReadTool();

  it('returns error when file_path is missing', async () => {
    const result = await tool.execute({}, makeCtx(tmpDir));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/file_path is required/i);
  });

  it('returns error when file does not exist', async () => {
    const result = await tool.execute(
      { file_path: path.join(tmpDir, 'nonexistent.txt') },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not found/i);
  });

  it('returns error when path points to a directory', async () => {
    const result = await tool.execute({ file_path: tmpDir }, makeCtx(tmpDir));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/directory/i);
  });
});

describe('ReadTool — text files', () => {
  const tool = new ReadTool();

  it('reads a simple text file with line numbers', async () => {
    const filePath = path.join(tmpDir, 'hello.txt');
    await fs.writeFile(filePath, 'line one\nline two\nline three\n', 'utf-8');

    const result = await tool.execute({ file_path: filePath }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.content).toContain('line one');
    expect(result.content).toContain('line two');
    expect(result.content).toContain('line three');
    // Verify cat -n numbering
    expect(result.content).toMatch(/^\s*1\t/m);
    expect(result.content).toMatch(/^\s*2\t/m);
    expect(result.content).toMatch(/^\s*3\t/m);
  });

  it('reports empty file', async () => {
    const filePath = path.join(tmpDir, 'empty.txt');
    await fs.writeFile(filePath, '', 'utf-8');

    const result = await tool.execute({ file_path: filePath }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.content).toContain('This file is empty');
  });

  it('resolves relative path against ctx.cwd', async () => {
    const filePath = path.join(tmpDir, 'rel.txt');
    await fs.writeFile(filePath, 'relative read\n', 'utf-8');

    const result = await tool.execute({ file_path: 'rel.txt' }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.content).toContain('relative read');
  });

  it('respects limit parameter', async () => {
    const filePath = path.join(tmpDir, 'long.txt');
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
    await fs.writeFile(filePath, lines, 'utf-8');

    const result = await tool.execute(
      { file_path: filePath, limit: 10 },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(false);
    // Should contain truncation notice
    expect(result.content).toMatch(/Use offset=\d+ to continue reading/i);
    // Should have lines 1-10 but not line 11
    expect(result.content).toContain('line 10');
    expect(result.content).not.toMatch(/^\s*11\t/m);
  });

  it('respects offset parameter (1-based)', async () => {
    const filePath = path.join(tmpDir, 'offset.txt');
    const lines = 'first\nsecond\nthird\nfourth\nfifth\n';
    await fs.writeFile(filePath, lines, 'utf-8');

    // offset=3 should skip lines 1-2 and start at line 3
    const result = await tool.execute(
      { file_path: filePath, offset: 3, limit: 10 },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain('first');
    expect(result.content).not.toContain('second');
    expect(result.content).toContain('third');
    expect(result.content).toContain('fourth');
  });

  it('returns error when offset exceeds total line count', async () => {
    const filePath = path.join(tmpDir, 'small.txt');
    await fs.writeFile(filePath, 'one\ntwo\n', 'utf-8');

    const result = await tool.execute(
      { file_path: filePath, offset: 999 },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Requested line 999 is beyond this file's 3 lines");
  });
});

describe('ReadTool — metadata', () => {
  const tool = new ReadTool();

  it('has permissionLevel readonly', () => {
    expect(tool.permissionLevel).toBe('readonly');
  });

  it('has a non-empty description', () => {
    expect(typeof tool.description).toBe('string');
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it('has an inputSchema object', () => {
    expect(typeof tool.inputSchema).toBe('object');
  });
});

// ===========================================================================
// WriteTool
// ===========================================================================

describe('WriteTool — input validation', () => {
  const tool = new WriteTool();

  it('returns error when file_path is missing', async () => {
    const result = await tool.execute({ content: 'x' }, makeCtx(tmpDir));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/file_path is required/i);
  });

  it('returns error when content is missing', async () => {
    const result = await tool.execute(
      { file_path: path.join(tmpDir, 'out.txt') },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/content is required/i);
  });
});

describe('WriteTool — file creation', () => {
  const tool = new WriteTool();

  it('creates a new file and reports Created', async () => {
    const filePath = path.join(tmpDir, 'new.txt');
    const result = await tool.execute(
      { file_path: filePath, content: 'hello world\n' },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/created/i);
    const written = await fs.readFile(filePath, 'utf-8');
    expect(written).toBe('hello world\n');
  });

  it('overwrites an existing file and reports Wrote', async () => {
    const filePath = path.join(tmpDir, 'existing.txt');
    await fs.writeFile(filePath, 'old content\n', 'utf-8');

    const result = await tool.execute(
      { file_path: filePath, content: 'new content\n' },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/wrote/i);
    const written = await fs.readFile(filePath, 'utf-8');
    expect(written).toBe('new content\n');
  });

  it('creates intermediate parent directories', async () => {
    const filePath = path.join(tmpDir, 'deep', 'nested', 'file.txt');
    const result = await tool.execute(
      { file_path: filePath, content: 'nested\n' },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(false);
    const written = await fs.readFile(filePath, 'utf-8');
    expect(written).toBe('nested\n');
  });

  it('resolves relative path against ctx.cwd', async () => {
    const result = await tool.execute(
      { file_path: 'relative.txt', content: 'from relative path\n' },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(false);
    const filePath = path.join(tmpDir, 'relative.txt');
    const written = await fs.readFile(filePath, 'utf-8');
    expect(written).toBe('from relative path\n');
  });

  it('includes line count and byte count in metadata', async () => {
    const filePath = path.join(tmpDir, 'meta.txt');
    const content = 'line1\nline2\nline3\n';
    const result = await tool.execute(
      { file_path: filePath, content },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(false);
    expect(result.metadata?.lines).toBeGreaterThanOrEqual(3);
    expect(result.metadata?.bytes).toBe(Buffer.byteLength(content, 'utf-8'));
  });

  it('sets is_new=true for new file, is_new=false for overwrite', async () => {
    const filePath = path.join(tmpDir, 'isnew.txt');

    const r1 = await tool.execute(
      { file_path: filePath, content: 'v1\n' },
      makeCtx(tmpDir),
    );
    expect(r1.metadata?.is_new).toBe(true);

    const r2 = await tool.execute(
      { file_path: filePath, content: 'v2\n' },
      makeCtx(tmpDir),
    );
    expect(r2.metadata?.is_new).toBe(false);
  });

  it('calls recordFileChange with before/after buffers', async () => {
    const filePath = path.join(tmpDir, 'record.txt');
    await fs.writeFile(filePath, 'before\n', 'utf-8');

    const recordFileChange = vi.fn();
    const ctx: ToolContext = { ...makeCtx(tmpDir), recordFileChange };

    await tool.execute({ file_path: filePath, content: 'after\n' }, ctx);

    expect(recordFileChange).toHaveBeenCalledOnce();
    const [, before, after] = recordFileChange.mock.calls[0] as [string, Buffer, Buffer];
    expect(before.toString('utf-8')).toBe('before\n');
    expect(after.toString('utf-8')).toBe('after\n');
  });

  it('handles empty string content', async () => {
    const filePath = path.join(tmpDir, 'empty.txt');
    const result = await tool.execute(
      { file_path: filePath, content: '' },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(false);
    const written = await fs.readFile(filePath, 'utf-8');
    expect(written).toBe('');
  });
});

describe('WriteTool — metadata', () => {
  const tool = new WriteTool();

  it('has permissionLevel write', () => {
    expect(tool.permissionLevel).toBe('write');
  });
});

// ===========================================================================
// EditTool
// ===========================================================================

describe('EditTool — input validation', () => {
  const tool = new EditTool();

  it('returns error when file_path is missing', async () => {
    const result = await tool.execute(
      { old_string: 'a', new_string: 'b' },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/file_path is required/i);
  });

  it('returns error when old_string is missing', async () => {
    const filePath = path.join(tmpDir, 'f.txt');
    await fs.writeFile(filePath, 'x', 'utf-8');
    const result = await tool.execute(
      { file_path: filePath, new_string: 'b' },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/old_string is required/i);
  });

  it('returns error when new_string is missing', async () => {
    const filePath = path.join(tmpDir, 'f.txt');
    await fs.writeFile(filePath, 'x', 'utf-8');
    const result = await tool.execute(
      { file_path: filePath, old_string: 'a' },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/new_string is required/i);
  });

  it('returns error when old_string === new_string', async () => {
    const filePath = path.join(tmpDir, 'f.txt');
    await fs.writeFile(filePath, 'abc', 'utf-8');
    const result = await tool.execute(
      { file_path: filePath, old_string: 'abc', new_string: 'abc' },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Edit rejected identical old_string and new_string values');
    expect(await fs.readFile(filePath, 'utf-8')).toBe('abc');
  });

  it('returns error when file does not exist', async () => {
    const result = await tool.execute(
      {
        file_path: path.join(tmpDir, 'missing.txt'),
        old_string: 'a',
        new_string: 'b',
      },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/failed to read/i);
  });
});

describe('EditTool — replacement logic', () => {
  const tool = new EditTool();

  it('replaces a unique occurrence', async () => {
    const filePath = path.join(tmpDir, 'edit.txt');
    await fs.writeFile(filePath, 'hello world\n', 'utf-8');

    const result = await tool.execute(
      { file_path: filePath, old_string: 'world', new_string: 'earth' },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/successfully edited/i);
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('hello earth\n');
  });

  it('returns error when old_string not found', async () => {
    const filePath = path.join(tmpDir, 'edit.txt');
    await fs.writeFile(filePath, 'hello world\n', 'utf-8');

    const result = await tool.execute(
      { file_path: filePath, old_string: 'NOTFOUND', new_string: 'x' },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Edit found no literal match for old_string');
    expect(result.content).toContain('Read the target again');
    expect(await fs.readFile(filePath, 'utf-8')).toBe('hello world\n');
  });

  it('returns error when old_string appears multiple times without replace_all', async () => {
    const filePath = path.join(tmpDir, 'dup.txt');
    await fs.writeFile(filePath, 'foo bar foo\n', 'utf-8');

    const result = await tool.execute(
      { file_path: filePath, old_string: 'foo', new_string: 'baz' },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/2 times/);
    expect(result.content).toContain('replace_all=true');
    expect(await fs.readFile(filePath, 'utf-8')).toBe('foo bar foo\n');
  });

  it('replaces all occurrences with replace_all=true', async () => {
    const filePath = path.join(tmpDir, 'dup.txt');
    await fs.writeFile(filePath, 'foo bar foo\n', 'utf-8');

    const result = await tool.execute(
      { file_path: filePath, old_string: 'foo', new_string: 'baz', replace_all: true },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(false);
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('baz bar baz\n');
    expect(result.metadata?.replacements).toBe(2);
  });

  it('reports replacements=1 for single replacement', async () => {
    const filePath = path.join(tmpDir, 'single.txt');
    await fs.writeFile(filePath, 'alpha beta\n', 'utf-8');

    const result = await tool.execute(
      { file_path: filePath, old_string: 'alpha', new_string: 'gamma' },
      makeCtx(tmpDir),
    );
    expect(result.metadata?.replacements).toBe(1);
  });

  it('replaces only the first occurrence (no replace_all)', async () => {
    const filePath = path.join(tmpDir, 'first.txt');
    await fs.writeFile(filePath, 'aXa\n', 'utf-8');

    // Only one occurrence — will succeed
    const result = await tool.execute(
      { file_path: filePath, old_string: 'X', new_string: 'Y' },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(false);
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('aYa\n');
  });

  it('calls recordFileChange with correct before/after buffers', async () => {
    const filePath = path.join(tmpDir, 'rc.txt');
    await fs.writeFile(filePath, 'before text\n', 'utf-8');

    const recordFileChange = vi.fn();
    const ctx: ToolContext = { ...makeCtx(tmpDir), recordFileChange };

    await tool.execute(
      { file_path: filePath, old_string: 'before', new_string: 'after' },
      ctx,
    );

    expect(recordFileChange).toHaveBeenCalledOnce();
    const [, before, after] = recordFileChange.mock.calls[0] as [string, Buffer, Buffer];
    expect(before.toString('utf-8')).toBe('before text\n');
    expect(after.toString('utf-8')).toBe('after text\n');
  });

  it('resolves relative file_path against ctx.cwd', async () => {
    const filePath = path.join(tmpDir, 'rel.txt');
    await fs.writeFile(filePath, 'foo\n', 'utf-8');

    const result = await tool.execute(
      { file_path: 'rel.txt', old_string: 'foo', new_string: 'bar' },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(false);
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('bar\n');
  });

  it('handles multiline old_string replacement', async () => {
    const filePath = path.join(tmpDir, 'multi.txt');
    await fs.writeFile(filePath, 'line1\nline2\nline3\n', 'utf-8');

    const result = await tool.execute(
      {
        file_path: filePath,
        old_string: 'line1\nline2',
        new_string: 'replaced',
      },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(false);
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('replaced\nline3\n');
  });
});

describe('EditTool — metadata', () => {
  const tool = new EditTool();

  it('has permissionLevel write', () => {
    expect(tool.permissionLevel).toBe('write');
  });
});

// ===========================================================================
// GlobTool
// ===========================================================================

describe('GlobTool — input validation', () => {
  const tool = new GlobTool();

  it('returns error when pattern is missing', async () => {
    const result = await tool.execute({}, makeCtx(tmpDir));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/pattern is required/i);
  });

  it('returns error when path does not exist', async () => {
    const result = await tool.execute(
      { pattern: '**/*.ts', path: path.join(tmpDir, 'no-such-dir') },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not found/i);
  });

  it('returns error when path is a file not a directory', async () => {
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.writeFile(filePath, 'x', 'utf-8');

    const result = await tool.execute(
      { pattern: '*.txt', path: filePath },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not a directory/i);
  });
});

describe('GlobTool — pattern matching', () => {
  const tool = new GlobTool();

  it('returns "No files matched" when pattern finds nothing', async () => {
    const result = await tool.execute(
      { pattern: '**/*.xyz_nonexistent' },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/no files matched/i);
  });

  it('matches files by extension', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.ts'), '', 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'b.ts'), '', 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'c.js'), '', 'utf-8');

    const result = await tool.execute({ pattern: '*.ts' }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.content).toContain('a.ts');
    expect(result.content).toContain('b.ts');
    expect(result.content).not.toContain('c.js');
  });

  it('matches files in nested directories with ** pattern', async () => {
    await fs.mkdir(path.join(tmpDir, 'sub'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'sub', 'deep.ts'), '', 'utf-8');

    const result = await tool.execute({ pattern: '**/*.ts' }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.content).toContain('deep.ts');
  });

  it.each(['**/halo-dev/**', 'halo-dev/**'])('matches skill descendants with %s', async (pattern) => {
    const baseDir = path.join(tmpDir, '.agents', 'skills');
    const skillDir = path.join(baseDir, 'halo-dev');
    await fs.mkdir(path.join(skillDir, 'references'), { recursive: true });
    const files = [path.join(skillDir, 'SKILL.md'), path.join(skillDir, 'references', 'guide.md')];
    for (const file of files) await fs.writeFile(file, '');
    await fs.mkdir(path.join(baseDir, 'other'));
    await fs.writeFile(path.join(baseDir, 'other', 'SKILL.md'), '');

    const result = await tool.execute({ pattern, path: baseDir }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.content.trim().split('\n').sort()).toEqual(files.sort());
  });

  it('matches a named file inside a named directory', async () => {
    const skill = path.join(tmpDir, '.agents', 'skills', 'halo-dev', 'SKILL.md');
    await fs.mkdir(path.dirname(skill), { recursive: true });
    for (const file of [skill, path.join(tmpDir, '.agents', 'skills', 'halo-dev', 'OTHER.md')]) {
      await fs.writeFile(file, '');
    }

    const result = await tool.execute(
      { pattern: 'halo-dev/SKILL.md', path: path.join(tmpDir, '.agents', 'skills') },
      makeCtx(tmpDir),
    );
    expect(result.content.trim()).toBe(skill);
  });

  it('matches exactly one directory with */SKILL.md', async () => {
    await fs.mkdir(path.join(tmpDir, 'skill', 'nested'), { recursive: true });
    const direct = path.join(tmpDir, 'skill', 'SKILL.md');
    for (const file of [path.join(tmpDir, 'SKILL.md'), direct, path.join(tmpDir, 'skill', 'nested', 'SKILL.md')]) {
      await fs.writeFile(file, '');
    }

    const result = await tool.execute({ pattern: '*/SKILL.md' }, makeCtx(tmpDir));
    expect(result.content.trim()).toBe(direct);
  });

  it('matches src/**/*.ts relative to the initial search directory', async () => {
    await fs.mkdir(path.join(tmpDir, 'src', 'nested'), { recursive: true });
    const files = [path.join(tmpDir, 'src', 'direct.ts'), path.join(tmpDir, 'src', 'nested', 'deep.ts')];
    for (const file of [...files, path.join(tmpDir, 'outside.ts')]) await fs.writeFile(file, '');

    const result = await tool.execute({ pattern: 'src/**/*.ts' }, makeCtx(tmpDir));
    expect(result.content.trim().split('\n').sort()).toEqual(files.sort());
  });

  it('does not match nested files with a single star', async () => {
    await fs.mkdir(path.join(tmpDir, 'src', 'nested'), { recursive: true });
    const root = path.join(tmpDir, 'root.ts');
    for (const file of [root, path.join(tmpDir, 'src', 'direct.ts'), path.join(tmpDir, 'src', 'nested', 'deep.ts')]) {
      await fs.writeFile(file, '');
    }

    const result = await tool.execute({ pattern: '*.ts' }, makeCtx(tmpDir));
    expect(result.content.trim()).toBe(root);
    const recursive = await tool.execute({ pattern: '**/*.ts' }, makeCtx(tmpDir));
    expect(recursive.content.trim().split('\n')).toHaveLength(3);
  });

  it('uses a symlink search root without following nested directory links', async () => {
    const baseDir = path.join(tmpDir, 'skills');
    await fs.mkdir(path.join(baseDir, 'halo-dev'), { recursive: true });
    await fs.writeFile(path.join(baseDir, 'halo-dev', 'SKILL.md'), '');
    const alias = path.join(tmpDir, 'alias');
    await fs.symlink(baseDir, alias, 'junction');
    await fs.symlink(baseDir, path.join(baseDir, 'nested-link'), 'junction');

    const result = await tool.execute({ pattern: 'halo-dev/**', path: alias }, makeCtx(tmpDir));
    expect(result.content.trim()).toBe(path.join(alias, 'halo-dev', 'SKILL.md'));
    const recursive = await tool.execute({ pattern: '**/SKILL.md', path: alias }, makeCtx(tmpDir));
    expect(recursive.content.trim()).toBe(path.join(alias, 'halo-dev', 'SKILL.md'));
  });

  it('uses absolute path parameter when provided', async () => {
    const subDir = path.join(tmpDir, 'subdir');
    await fs.mkdir(subDir);
    await fs.writeFile(path.join(subDir, 'match.txt'), '', 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'no-match.txt'), '', 'utf-8');

    const result = await tool.execute(
      { pattern: '*.txt', path: subDir },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('match.txt');
    // no-match.txt is outside subDir
    expect(result.content).not.toContain('no-match.txt');
  });

  it('resolves relative path parameter against ctx.cwd', async () => {
    const subDir = path.join(tmpDir, 'rel');
    await fs.mkdir(subDir);
    await fs.writeFile(path.join(subDir, 'found.ts'), '', 'utf-8');

    const result = await tool.execute(
      { pattern: '*.ts', path: 'rel' },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('found.ts');
  });

  it('skips node_modules directory', async () => {
    const nm = path.join(tmpDir, 'node_modules', 'pkg');
    await fs.mkdir(nm, { recursive: true });
    await fs.writeFile(path.join(nm, 'hidden.ts'), '', 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'visible.ts'), '', 'utf-8');

    const result = await tool.execute({ pattern: '**/*.ts' }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.content).toContain('visible.ts');
    expect(result.content).not.toContain('hidden.ts');
  });

  it('skips .git directory', async () => {
    const git = path.join(tmpDir, '.git', 'objects');
    await fs.mkdir(git, { recursive: true });
    await fs.writeFile(path.join(git, 'gitfile.ts'), '', 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'src.ts'), '', 'utf-8');

    const result = await tool.execute({ pattern: '**/*.ts' }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.content).toContain('src.ts');
    expect(result.content).not.toContain('gitfile.ts');
  });

  it('does NOT skip arbitrary hidden directories (e.g. .claude)', async () => {
    const hidden = path.join(tmpDir, '.claude');
    await fs.mkdir(hidden);
    await fs.writeFile(path.join(hidden, 'settings.json'), '', 'utf-8');

    const result = await tool.execute({ pattern: '**/*.json' }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.content).toContain('settings.json');
  });

  it.each(['file+name.ts', 'file(name).ts', 'file^name$.ts', 'file(.ts', '#config.ts', '!config.ts',
    ...(process.platform === 'win32' ? [] : ['file|name.ts'])])(
    'treats non-glob regex punctuation literally in %s', async (filename) => {
      const expected = path.join(tmpDir, filename);
      await fs.writeFile(expected, '');
      await fs.writeFile(path.join(tmpDir, 'filename.ts'), '');
      const result = await tool.execute({ pattern: filename }, makeCtx(tmpDir));
      expect(result.isError).toBe(false);
      expect(result.content.trim()).toBe(expected);
    },
  );

  it('supports brace alternatives, nested alternatives, and numeric ranges', async () => {
    const files = ['one.ts', 'two.tsx', 'three.js', 'part1.txt', 'part2.txt', 'part3.txt', 'other.md'];
    for (const filename of files) await fs.writeFile(path.join(tmpDir, filename), '');
    const alternatives = await tool.execute({ pattern: '*.{ts,{tsx,js}}' }, makeCtx(tmpDir));
    expect(alternatives.content.trim().split('\n').map((file) => path.basename(file)).sort()).toEqual(['one.ts', 'three.js', 'two.tsx']);
    const range = await tool.execute({ pattern: 'part{1..2}.txt' }, makeCtx(tmpDir));
    expect(range.content.trim().split('\n').map((file) => path.basename(file)).sort()).toEqual(['part1.txt', 'part2.txt']);
  });

  it('supports character classes, extglobs, and escaped literal glob characters', async () => {
    const files = ['file1.ts', 'file2.ts', 'file3.ts', 'foo.ts', 'bar.ts', 'baz.ts', 'file+(draft).ts'];
    for (const filename of files) await fs.writeFile(path.join(tmpDir, filename), '');
    const classes = await tool.execute({ pattern: 'file[12].ts' }, makeCtx(tmpDir));
    expect(classes.content.trim().split('\n').map((file) => path.basename(file)).sort()).toEqual(['file1.ts', 'file2.ts']);
    const extglob = await tool.execute({ pattern: '@(foo|bar).ts' }, makeCtx(tmpDir));
    expect(extglob.content.trim().split('\n').map((file) => path.basename(file)).sort()).toEqual(['bar.ts', 'foo.ts']);
    const literal = await tool.execute({ pattern: 'file[+][(]draft[)].ts' }, makeCtx(tmpDir));
    expect(literal.content.trim()).toBe(path.join(tmpDir, 'file+(draft).ts'));
  });

  it('accepts Windows pattern separators without changing returned paths', async () => {
    const filePath = path.join(tmpDir, 'src', 'nested', 'example.ts');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '');
    const result = await tool.execute({ pattern: 'src\\**\\*.{ts,tsx}' }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.content.trim()).toBe(filePath);
  });

  it('matches a root file with globstar and preserves case-insensitive matching', async () => {
    const filePath = path.join(tmpDir, 'ROOT.TS');
    await fs.writeFile(filePath, '');
    const result = await tool.execute({ pattern: '**/*.ts' }, makeCtx(tmpDir));
    expect(result.content.trim()).toBe(filePath);
  });

  it('sorts results by modification time (most recent first)', async () => {
    const older = path.join(tmpDir, 'older.txt');
    const newer = path.join(tmpDir, 'newer.txt');

    await fs.writeFile(older, '', 'utf-8');
    // Small delay to ensure different mtime
    await new Promise((r) => setTimeout(r, 50));
    await fs.writeFile(newer, '', 'utf-8');

    const result = await tool.execute({ pattern: '*.txt' }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    const lines = result.content.trim().split('\n').filter(Boolean);
    const newerIdx = lines.findIndex((l) => l.includes('newer.txt'));
    const olderIdx = lines.findIndex((l) => l.includes('older.txt'));
    expect(newerIdx).toBeLessThan(olderIdx);
  });

  it('matches files with ? wildcard (single char)', async () => {
    await fs.writeFile(path.join(tmpDir, 'file1.ts'), '', 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'file2.ts'), '', 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'file.ts'), '', 'utf-8');

    const result = await tool.execute({ pattern: 'file?.ts' }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.content).toContain('file1.ts');
    expect(result.content).toContain('file2.ts');
    // file.ts has no character at position of '?'
    const lines = result.content.trim().split('\n');
    const hasBareFile = lines.some((l) => l.trim().endsWith('file.ts'));
    expect(hasBareFile).toBe(false);
  });
});

describe('GlobTool — metadata', () => {
  const tool = new GlobTool();

  it('has permissionLevel readonly', () => {
    expect(tool.permissionLevel).toBe('readonly');
  });

  it('has a non-empty description', () => {
    expect(typeof tool.description).toBe('string');
    expect(tool.description.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Read-before-write enforcement (B2)
// Read-before-write enforcement for WriteTool and EditTool.
// ===========================================================================

function makeStrictCtx(cwd: string): ToolContext & { readFileState: Map<string, FileReadState> } {
  const readFileState = new Map<string, FileReadState>();
  return {
    sessionId: 'test-strict',
    cwd,
    abortSignal: new AbortController().signal,
    costTracker: new CostTracker('test-model'),
    currentTurn: 0,
    env: {},
    readFileState,
  };
}

describe('Read-before-write — WriteTool', () => {
  const read = new ReadTool();
  const write = new WriteTool();

  it('rejects overwrite of an existing file that has not been read', async () => {
    const filePath = path.join(tmpDir, 'existing.txt');
    await fs.writeFile(filePath, 'old\n', 'utf-8');

    const ctx = makeStrictCtx(tmpDir);
    const result = await write.execute(
      { file_path: filePath, content: 'new\n' },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Write requires a complete Read of the existing file');
    expect(result.content).toContain('use Edit for a targeted change');
    // File should be untouched
    expect(await fs.readFile(filePath, 'utf-8')).toBe('old\n');
  });

  it('allows creating a brand-new file without a prior Read (ENOENT path)', async () => {
    const filePath = path.join(tmpDir, 'brand-new.txt');
    const ctx = makeStrictCtx(tmpDir);

    const result = await write.execute(
      { file_path: filePath, content: 'fresh\n' },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(await fs.readFile(filePath, 'utf-8')).toBe('fresh\n');
  });

  it('allows overwrite after a prior Read', async () => {
    const filePath = path.join(tmpDir, 'after-read.txt');
    await fs.writeFile(filePath, 'v1\n', 'utf-8');

    const ctx = makeStrictCtx(tmpDir);
    await read.execute({ file_path: filePath }, ctx);
    const result = await write.execute(
      { file_path: filePath, content: 'v2\n' },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(await fs.readFile(filePath, 'utf-8')).toBe('v2\n');
  });

  it('rejects overwrite if the file was modified after Read (stale write)', async () => {
    const filePath = path.join(tmpDir, 'stale.txt');
    await fs.writeFile(filePath, 'v1\n', 'utf-8');

    const ctx = makeStrictCtx(tmpDir);
    await read.execute({ file_path: filePath }, ctx);

    // Force the cached timestamp into the past so the next write is "stale".
    const state = ctx.readFileState.get(filePath)!;
    ctx.readFileState.set(filePath, { ...state, timestamp: state.timestamp - 1000 });

    const result = await write.execute(
      { file_path: filePath, content: 'v2\n' },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/no longer matches its recorded read.*current contents/i);
    expect(await fs.readFile(filePath, 'utf-8')).toBe('v1\n');
  });

  it('rejects overwrite when the read was a partial view (offset/limit truncated)', async () => {
    const filePath = path.join(tmpDir, 'big.txt');
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    await fs.writeFile(filePath, lines, 'utf-8');

    const ctx = makeStrictCtx(tmpDir);
    // Partial read — only first 10 lines.
    await read.execute({ file_path: filePath, limit: 10 }, ctx);
    expect(ctx.readFileState.get(filePath)?.isPartialView).toBe(true);

    const result = await write.execute(
      { file_path: filePath, content: 'replacement\n' },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Write requires a complete Read of the existing file');
    expect(result.content).toContain('use Edit for a targeted change');
  });

  it('refreshes readFileState after a successful write so a follow-up Write succeeds', async () => {
    const filePath = path.join(tmpDir, 'chain.txt');
    await fs.writeFile(filePath, 'v1\n', 'utf-8');

    const ctx = makeStrictCtx(tmpDir);
    await read.execute({ file_path: filePath }, ctx);

    const r1 = await write.execute(
      { file_path: filePath, content: 'v2\n' },
      ctx,
    );
    expect(r1.isError).toBe(false);

    // Without a fresh Read, a second write should still succeed because the
    // first write refreshed readFileState.
    const r2 = await write.execute(
      { file_path: filePath, content: 'v3\n' },
      ctx,
    );
    expect(r2.isError).toBe(false);
    expect(await fs.readFile(filePath, 'utf-8')).toBe('v3\n');
  });
});

describe('Read-before-write — EditTool', () => {
  const read = new ReadTool();
  const edit = new EditTool();

  it('rejects edit of a file that has not been read', async () => {
    const filePath = path.join(tmpDir, 'noread.txt');
    await fs.writeFile(filePath, 'foo bar\n', 'utf-8');

    const ctx = makeStrictCtx(tmpDir);
    const result = await edit.execute(
      { file_path: filePath, old_string: 'foo', new_string: 'baz' },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Edit needs a recorded Read of this file');
    expect(result.content).toContain('Read the target');
    expect(await fs.readFile(filePath, 'utf-8')).toBe('foo bar\n');
  });

  it('allows edit after a prior full Read', async () => {
    const filePath = path.join(tmpDir, 'editme.txt');
    await fs.writeFile(filePath, 'foo bar\n', 'utf-8');

    const ctx = makeStrictCtx(tmpDir);
    await read.execute({ file_path: filePath }, ctx);
    const result = await edit.execute(
      { file_path: filePath, old_string: 'foo', new_string: 'baz' },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(await fs.readFile(filePath, 'utf-8')).toBe('baz bar\n');
  });

  it('rejects edit when the file was modified since Read (no full-read fallback)', async () => {
    const filePath = path.join(tmpDir, 'stale-edit.txt');
    await fs.writeFile(filePath, 'foo\n', 'utf-8');

    const ctx = makeStrictCtx(tmpDir);
    await read.execute({ file_path: filePath }, ctx);

    await fs.writeFile(filePath, 'foo changed externally\n', 'utf-8');

    const result = await edit.execute(
      { file_path: filePath, old_string: 'foo', new_string: 'baz' },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/no longer matches its recorded read.*current contents/i);
  });

  it('allows edit when mtime advanced but on-disk content matches cached full-read content', async () => {
    const filePath = path.join(tmpDir, 'fallback.txt');
    await fs.writeFile(filePath, 'foo bar\n', 'utf-8');

    const ctx = makeStrictCtx(tmpDir);
    await read.execute({ file_path: filePath }, ctx);

    // Simulate spurious mtime change (cloud sync / antivirus) without
    // changing content — backdate the cached timestamp so disk mtime > cache.
    const state = ctx.readFileState.get(filePath)!;
    ctx.readFileState.set(filePath, { ...state, timestamp: state.timestamp - 1000 });

    const result = await edit.execute(
      { file_path: filePath, old_string: 'foo', new_string: 'baz' },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(await fs.readFile(filePath, 'utf-8')).toBe('baz bar\n');
  });

  it('allows edit after a partial read; stale partial view still rejected', async () => {
    const filePath = path.join(tmpDir, 'partial.txt');
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    await fs.writeFile(filePath, lines, 'utf-8');

    const ctx = makeStrictCtx(tmpDir);
    await read.execute({ file_path: filePath, limit: 5 }, ctx);
    expect(ctx.readFileState.get(filePath)?.isPartialView).toBe(true);

    const result = await edit.execute(
      { file_path: filePath, old_string: 'line 1\n', new_string: 'LINE_ONE\n' },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(await fs.readFile(filePath, 'utf-8')).toContain('LINE_ONE');

    // Stale partial view (mtime advanced, body changed): the content-unchanged
    // fallback is reserved for full reads, so this must stay rejected.
    await fs.writeFile(filePath, 'totally different\n', 'utf-8');
    const state = ctx.readFileState.get(filePath)!;
    ctx.readFileState.set(filePath, { ...state, timestamp: state.timestamp - 1000 });
    const stale = await edit.execute(
      { file_path: filePath, old_string: 'different', new_string: 'other' },
      ctx,
    );
    expect(stale.isError).toBe(true);
    expect(stale.content).toMatch(/no longer matches its recorded read.*current contents/i);
  });

  it('refreshes readFileState after a successful edit so a follow-up Edit succeeds', async () => {
    const filePath = path.join(tmpDir, 'chain-edit.txt');
    await fs.writeFile(filePath, 'a b c\n', 'utf-8');

    const ctx = makeStrictCtx(tmpDir);
    await read.execute({ file_path: filePath }, ctx);

    const r1 = await edit.execute(
      { file_path: filePath, old_string: 'a', new_string: 'A' },
      ctx,
    );
    expect(r1.isError).toBe(false);

    // No re-Read — second edit should still succeed.
    const r2 = await edit.execute(
      { file_path: filePath, old_string: 'b', new_string: 'B' },
      ctx,
    );
    expect(r2.isError).toBe(false);
    expect(await fs.readFile(filePath, 'utf-8')).toBe('A B c\n');
  });
});

describe('Read-before-write — ReadTool populates readFileState', () => {
  const read = new ReadTool();

  it('records a non-partial entry for a small full read', async () => {
    const filePath = path.join(tmpDir, 'small.txt');
    await fs.writeFile(filePath, 'one\ntwo\n', 'utf-8');

    const ctx = makeStrictCtx(tmpDir);
    await read.execute({ file_path: filePath }, ctx);

    const state = ctx.readFileState.get(filePath);
    expect(state).toBeDefined();
    expect(state!.isPartialView).toBeUndefined();
    expect(state!.offset).toBeUndefined();
    expect(state!.limit).toBeUndefined();
    expect(state!.content).toBe('one\ntwo\n');
    expect(state!.timestamp).toBeGreaterThan(0);
  });

  it('marks isPartialView=true when limit truncates the file', async () => {
    const filePath = path.join(tmpDir, 'huge.txt');
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
    await fs.writeFile(filePath, lines, 'utf-8');

    const ctx = makeStrictCtx(tmpDir);
    await read.execute({ file_path: filePath, limit: 10 }, ctx);

    const state = ctx.readFileState.get(filePath);
    expect(state).toBeDefined();
    expect(state!.isPartialView).toBe(true);
    expect(state!.limit).toBe(10);
  });

  it('marks isPartialView=true when offset > 0 (model did not see leading lines)', async () => {
    const filePath = path.join(tmpDir, 'mid.txt');
    await fs.writeFile(filePath, 'a\nb\nc\nd\n', 'utf-8');

    const ctx = makeStrictCtx(tmpDir);
    await read.execute({ file_path: filePath, offset: 2 }, ctx);

    const state = ctx.readFileState.get(filePath);
    expect(state).toBeDefined();
    expect(state!.isPartialView).toBe(true);
    expect(state!.offset).toBe(2);
  });

  it('does not populate readFileState when ctx.readFileState is undefined (lenient mode)', async () => {
    const filePath = path.join(tmpDir, 'lenient.txt');
    await fs.writeFile(filePath, 'x\n', 'utf-8');

    const ctx = makeCtx(tmpDir);
    expect(ctx.readFileState).toBeUndefined();
    const result = await read.execute({ file_path: filePath }, ctx);
    expect(result.isError).toBe(false);
    // No throw is the assertion — lenient mode just no-ops on the cache write.
  });
});

describe('ReadTool — output line budget', () => {
  const tool = new ReadTool();

  it('narrows output on whole lines when the 40k char budget is exceeded', async () => {
    const filePath = path.join(tmpDir, 'wide.txt');
    // 100 lines × ~600 chars ≈ 60k chars — over budget, under the 2000-line cap.
    const longLine = 'x'.repeat(600);
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1} ${longLine}`).join('\n');
    await fs.writeFile(filePath, lines, 'utf-8');

    const result = await tool.execute({ file_path: filePath }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.content.length).toBeLessThanOrEqual(40_000 + 200);

    // No mid-line cut: every rendered line keeps the cat -n format, and the
    // continuation note names the next offset.
    const rendered = result.content.split('\n').filter((l) => /^\s*\d+\t/.test(l));
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(100);
    const lastRendered = rendered[rendered.length - 1];
    const lastLineNum = Number(lastRendered.split('\t')[0]);
    expect(result.content).toMatch(
      new RegExp(`showing lines 1-${lastLineNum} of 100\\. Use offset=${lastLineNum + 1} to continue`),
    );

    // Pagination contract: offset continues exactly where the budget stopped.
    const page2 = await tool.execute(
      { file_path: filePath, offset: lastLineNum + 1 },
      makeCtx(tmpDir),
    );
    expect(page2.isError).toBe(false);
    expect(page2.content).toMatch(new RegExp(`^\\s*${lastLineNum + 1}\\t`, 'm'));
  });

  it('marks the read as a partial view when the char budget truncates', async () => {
    const filePath = path.join(tmpDir, 'wide2.txt');
    const longLine = 'y'.repeat(700);
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1} ${longLine}`).join('\n');
    await fs.writeFile(filePath, lines, 'utf-8');

    const ctx = makeStrictCtx(tmpDir);
    await tool.execute({ file_path: filePath }, ctx);
    // No offset/limit were passed — the partial flag comes from the char cap.
    const state = ctx.readFileState.get(filePath)!;
    expect(state.offset).toBeUndefined();
    expect(state.limit).toBeUndefined();
    expect(state.isPartialView).toBe(true);
  });
});

describe('File tools — freshness and concurrency', () => {
  const read = new ReadTool();
  const write = new WriteTool();
  const edit = new EditTool();

  it.each([false, true])('rejects unauthorized Write before reading file bytes (partial=%s)', async partial => {
    const filePath = path.join(tmpDir, 'unauthorized.txt');
    await fs.writeFile(filePath, 'visible\nhidden');
    const ctx = makeStrictCtx(tmpDir);
    if (partial) await read.execute({ file_path: filePath, limit: 1 }, ctx);
    const snapshot = vi.spyOn(fileAccess, 'readFileSnapshot');
    try {
      const result = await write.execute({ file_path: filePath, content: 'overwrite' }, ctx);
      expect(result.isError).toBe(true);
      expect(snapshot).not.toHaveBeenCalled();
    } finally {
      snapshot.mockRestore();
    }
  });

  it('revokes read authorization when bytes change again after Edit writes', async () => {
    const filePath = path.join(tmpDir, 'changed-after-edit.txt');
    await fs.writeFile(filePath, 'original');
    const ctx = makeStrictCtx(tmpDir);
    await read.execute({ file_path: filePath }, ctx);
    const originalWrite = fileAccess.writeFileSnapshot;
    const writeSpy = vi.spyOn(fileAccess, 'writeFileSnapshot').mockImplementationOnce(async (...args) => {
      const stat = await originalWrite(...args);
      await fs.writeFile(filePath, 'external value');
      return stat;
    });
    try {
      const result = await edit.execute({ file_path: filePath, old_string: 'original', new_string: 'updated' }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toContain('changed again after this edit');
      expect(ctx.readFileState.has(filePath)).toBe(false);
      expect((await edit.execute({ file_path: filePath, old_string: 'external', new_string: 'lost' }, ctx)).isError).toBe(true);
      expect(await fs.readFile(filePath, 'utf8')).toBe('external value');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it.each(['write', 'edit'])('rejects %s after a same-size, same-mtime external change', async (operation) => {
    const filePath = path.join(tmpDir, 'same-time.txt');
    const stamp = new Date('2024-01-01T00:00:00.000Z');
    await fs.writeFile(filePath, 'alpha beta\n');
    await fs.utimes(filePath, stamp, stamp);
    const ctx = makeStrictCtx(tmpDir);
    await read.execute({ file_path: filePath }, ctx);
    await fs.writeFile(filePath, 'alpha zeta\n');
    await fs.utimes(filePath, stamp, stamp);
    expect((await fs.stat(filePath)).mtimeMs).toBe(ctx.readFileState.get(filePath)!.timestamp);
    const result = operation === 'write'
      ? await write.execute({ file_path: filePath, content: 'replacement' }, ctx)
      : await edit.execute({ file_path: filePath, old_string: 'alpha', new_string: 'changed' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('no longer matches its recorded read');
    expect(await fs.readFile(filePath, 'utf-8')).toBe('alpha zeta\n');
  });

  it.each(['write', 'edit'])('rejects %s when an external writer restores an older mtime', async (operation) => {
    const filePath = path.join(tmpDir, 'older-time.txt');
    await fs.writeFile(filePath, 'alpha beta\n');
    const ctx = makeStrictCtx(tmpDir);
    await read.execute({ file_path: filePath }, ctx);
    await fs.writeFile(filePath, 'alpha zeta\n');
    const stamp = new Date('2020-01-01T00:00:00.000Z');
    await fs.utimes(filePath, stamp, stamp);
    const result = operation === 'write'
      ? await write.execute({ file_path: filePath, content: 'replacement' }, ctx)
      : await edit.execute({ file_path: filePath, old_string: 'alpha', new_string: 'changed' }, ctx);
    expect(result.isError).toBe(true);
    expect(await fs.readFile(filePath, 'utf-8')).toBe('alpha zeta\n');
  });

  it('hashes original bytes rather than lossy UTF-8 decoding', async () => {
    const filePath = path.join(tmpDir, 'bytes.txt');
    const stamp = new Date('2024-01-01T00:00:00.000Z');
    await fs.writeFile(filePath, Buffer.from([0x61, 0xff]));
    await fs.utimes(filePath, stamp, stamp);
    const ctx = makeStrictCtx(tmpDir);
    await read.execute({ file_path: filePath }, ctx);
    await fs.writeFile(filePath, Buffer.from([0x61, 0xfe]));
    await fs.utimes(filePath, stamp, stamp);
    const result = await edit.execute({ file_path: filePath, old_string: 'a', new_string: 'b' }, ctx);
    expect(result.isError).toBe(true);
    expect(await fs.readFile(filePath)).toEqual(Buffer.from([0x61, 0xfe]));
  });

  it.each(['write/write', 'edit/edit', 'write/edit'])('permits only one concurrent %s from independent readers', async (operations) => {
    const filePath = path.join(tmpDir, 'concurrent.txt');
    await fs.writeFile(filePath, 'alpha beta\n');
    const first = makeStrictCtx(tmpDir);
    const second = makeStrictCtx(tmpDir);
    await Promise.all([read.execute({ file_path: filePath }, first), read.execute({ file_path: filePath }, second)]);
    const [left, right] = operations.split('/');
    const invoke = (operation: string, ctx: ToolContext, value: string) => operation === 'write'
      ? write.execute({ file_path: filePath, content: value }, ctx)
      : edit.execute({ file_path: filePath, old_string: 'alpha', new_string: value }, ctx);
    const results = await Promise.all([invoke(left, first, 'first'), invoke(right, second, 'second')]);
    expect(results.filter((result) => !result.isError)).toHaveLength(1);
    expect(results.filter((result) => result.isError)[0].content).toContain('no longer matches its recorded read');
    const actual = await fs.readFile(filePath, 'utf-8');
    expect(actual).toBe(left === 'write' ? 'first' : 'first beta\n');
  });

  it('does not let queued writes inherit a concurrent write\'s refreshed state', async () => {
    const filePath = path.join(tmpDir, 'shared-map.txt');
    await fs.writeFile(filePath, 'original');
    const ctx = makeStrictCtx(tmpDir);
    await read.execute({ file_path: filePath }, ctx);
    const results = await Promise.all([
      write.execute({ file_path: filePath, content: 'first' }, ctx),
      write.execute({ file_path: filePath, content: 'second' }, ctx),
    ]);
    expect(results.map((result) => result.isError)).toEqual([false, true]);
    expect(await fs.readFile(filePath, 'utf-8')).toBe('first');
  });

  it('allows only one concurrent creator without a read', async () => {
    const filePath = path.join(tmpDir, 'new.txt');
    const results = await Promise.all([
      write.execute({ file_path: filePath, content: 'first' }, makeStrictCtx(tmpDir)),
      write.execute({ file_path: filePath, content: 'second' }, makeStrictCtx(tmpDir)),
    ]);
    expect(results.map((result) => result.isError)).toEqual([false, true]);
    expect(await fs.readFile(filePath, 'utf-8')).toBe('first');
  });

  it('does not recreate a previously read file that was externally deleted', async () => {
    const filePath = path.join(tmpDir, 'deleted.txt');
    await fs.writeFile(filePath, 'original');
    const ctx = makeStrictCtx(tmpDir);
    await read.execute({ file_path: filePath }, ctx);
    await fs.unlink(filePath);
    const result = await write.execute({ file_path: filePath, content: 'replacement' }, ctx);
    expect(result.isError).toBe(true);
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes symlink aliases used by independent readers', async () => {
    const target = path.join(tmpDir, 'target');
    const alias = path.join(tmpDir, 'alias');
    await fs.mkdir(target);
    await fs.symlink(target, alias, 'junction');
    const firstPath = path.join(target, 'file.txt');
    const secondPath = path.join(alias, 'file.txt');
    await fs.writeFile(firstPath, 'original');
    const first = makeStrictCtx(tmpDir);
    const second = makeStrictCtx(tmpDir);
    await Promise.all([read.execute({ file_path: firstPath }, first), read.execute({ file_path: secondPath }, second)]);
    const results = await Promise.all([
      write.execute({ file_path: firstPath, content: 'first' }, first),
      write.execute({ file_path: secondPath, content: 'second' }, second),
    ]);
    expect(results.map((result) => result.isError)).toEqual([false, true]);
    expect(await fs.readFile(firstPath, 'utf-8')).toBe('first');
  });

  it('rejects an empty search string without looping', async () => {
    const filePath = path.join(tmpDir, 'empty-search.txt');
    await fs.writeFile(filePath, 'content');
    const result = await edit.execute({ file_path: filePath, old_string: '', new_string: 'prefix' }, makeCtx(tmpDir));
    expect(result.isError).toBe(true);
    expect(await fs.readFile(filePath, 'utf-8')).toBe('content');
  });
});

describe('File tools — bounded read state', () => {
  const read = new ReadTool();
  const write = new WriteTool();
  const edit = new EditTool();

  it('does not upgrade a partial Read through Edit to whole-file Write authority', async () => {
    const filePath = path.join(tmpDir, 'partial-chain.txt');
    await fs.writeFile(filePath, 'visible\nhidden\n');
    const ctx = makeStrictCtx(tmpDir);
    await read.execute({ file_path: filePath, limit: 1 }, ctx);
    const edited = await edit.execute({ file_path: filePath, old_string: 'visible', new_string: 'changed' }, ctx);
    expect(edited.isError).toBe(false);
    expect(ctx.readFileState.get(filePath)?.isPartialView).toBe(true);
    const written = await write.execute({ file_path: filePath, content: 'overwrite' }, ctx);
    expect(written.isError).toBe(true);
    expect(await fs.readFile(filePath, 'utf-8')).toBe('changed\nhidden\n');
    const again = await edit.execute({ file_path: filePath, old_string: 'changed', new_string: 'changed again' }, ctx);
    expect(again.isError).toBe(false);
  });

  it('does not retain a large file after a partial Read and successive Edits', async () => {
    const filePath = path.join(tmpDir, 'large-partial.txt');
    const content = 'visible\n' + 'hidden data\n'.repeat(100_000);
    await fs.writeFile(filePath, content);
    const ctx = makeStrictCtx(tmpDir);
    await read.execute({ file_path: filePath, limit: 1 }, ctx);
    expect(ctx.readFileState.get(filePath)?.content).toBe('visible');
    const edited = await edit.execute({ file_path: filePath, old_string: 'visible', new_string: 'changed' }, ctx);
    expect(edited.isError).toBe(false);
    const state = ctx.readFileState.get(filePath)!;
    expect(state.content).toBeUndefined();
    expect(state.contentHash).toHaveLength(64);
    expect(state.isPartialView).toBe(true);
    const again = await edit.execute({ file_path: filePath, old_string: 'changed', new_string: 'updated' }, ctx);
    expect(again.isError).toBe(false);
    expect(ctx.readFileState.get(filePath)?.content).toBeUndefined();
  });

  it('retains full-read authorization after text is omitted from the cache', async () => {
    const filePath = path.join(tmpDir, 'large-full.txt');
    const content = 'x'.repeat(10_000);
    await fs.writeFile(filePath, content);
    const ctx = makeStrictCtx(tmpDir);
    await read.execute({ file_path: filePath }, ctx);
    expect(ctx.readFileState.get(filePath)?.content).toBeUndefined();
    expect(ctx.readFileState.get(filePath)?.isPartialView).toBeUndefined();
    const result = await write.execute({ file_path: filePath, content: 'y'.repeat(20_000) }, ctx);
    expect(result.isError).toBe(false);
    expect(ctx.readFileState.get(filePath)?.content).toBeUndefined();
    const next = await write.execute({ file_path: filePath, content: 'final' }, ctx);
    expect(next.isError).toBe(false);
  });

  it('uses a digest for an unchanged full read after mtime-only changes', async () => {
    const filePath = path.join(tmpDir, 'large-fallback.txt');
    const content = 'x'.repeat(10_000) + ' ending';
    await fs.writeFile(filePath, content);
    const ctx = makeStrictCtx(tmpDir);
    await read.execute({ file_path: filePath }, ctx);
    const stamp = new Date('2020-01-01T00:00:00.000Z');
    await fs.utimes(filePath, stamp, stamp);
    const result = await edit.execute({ file_path: filePath, old_string: 'ending', new_string: 'updated' }, ctx);
    expect(result.isError).toBe(false);
    expect(await fs.readFile(filePath, 'utf-8')).toBe('x'.repeat(10_000) + ' updated');
  });

  it('marks oversized single-line output partial and does not cache it', async () => {
    const filePath = path.join(tmpDir, 'single-line.txt');
    await fs.writeFile(filePath, 'x'.repeat(100_000));
    const ctx = makeStrictCtx(tmpDir);
    const result = await read.execute({ file_path: filePath }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content.length).toBeLessThan(40_200);
    expect(result.content).toContain('line 1 was truncated');
    expect(ctx.readFileState.get(filePath)?.isPartialView).toBe(true);
    expect(ctx.readFileState.get(filePath)?.content).toBeUndefined();
    expect((await write.execute({ file_path: filePath, content: 'overwrite' }, ctx)).isError).toBe(true);
  });

  it('does not treat rendered notebook cells as a full raw-file read', async () => {
    const filePath = path.join(tmpDir, 'notebook.ipynb');
    const content = JSON.stringify({ cells: [{ cell_type: 'code', source: ['print(1)'] }], metadata: { hidden: true } });
    await fs.writeFile(filePath, content);
    const ctx = makeStrictCtx(tmpDir);
    expect((await read.execute({ file_path: filePath }, ctx)).isError).toBe(false);
    expect(ctx.readFileState.get(filePath)?.isPartialView).toBe(true);
    const edited = await edit.execute({ file_path: filePath, old_string: 'print(1)', new_string: 'print(2)' }, ctx);
    expect(edited.isError).toBe(false);
    expect((await write.execute({ file_path: filePath, content: '{}' }, ctx)).isError).toBe(true);
  });
});

describe('ReadTool — image files', () => {
  const tool = new ReadTool();

  it('returns base64 image data for a PNG', async () => {
    const filePath = path.join(tmpDir, 'pic.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await fs.writeFile(filePath, bytes);

    const result = await tool.execute({ file_path: filePath }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.content).toContain('captured for visual analysis');
    expect(result.images).toEqual([{ mimeType: 'image/png', data: bytes.toString('base64') }]);
  });

  it('returns text only for formats without a base64 wire type', async () => {
    const filePath = path.join(tmpDir, 'icon.ico');
    await fs.writeFile(filePath, Buffer.from([0, 1, 2, 3]));

    const result = await tool.execute({ file_path: filePath }, makeCtx(tmpDir));
    expect(result.isError).toBe(false);
    expect(result.images).toBeUndefined();
    expect(result.content).toContain('cannot be delivered for visual analysis');
    expect(result.content).not.toContain('captured for visual analysis');
  });

  it('errors on images larger than 5 MB', async () => {
    const filePath = path.join(tmpDir, 'huge.png');
    await fs.writeFile(filePath, Buffer.alloc(5 * 1024 * 1024 + 1));

    const result = await tool.execute({ file_path: filePath }, makeCtx(tmpDir));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/too large/i);
  });
});
