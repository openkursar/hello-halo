import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAllTools, releaseNativeToolOwner } from '../../../native/tools.js';
import type { ToolContext } from '../../../types/tool.js';

let root: string;
const tool = () => getAllTools().find(candidate => candidate.name === 'Grep')!;
function context(): ToolContext {
  return { cwd: root, env: {}, sessionId: 'grep-native-test', currentTurn: 0,
    abortSignal: new AbortController().signal, costTracker: {} as ToolContext['costTracker'] };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'grep-native-')));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'a.ts'), 'before\nneedle ONE\nafter\nneedle TWO\nlast\n');
  await writeFile(join(root, 'src', 'b.tsx'), 'needle THREE\n');
  await writeFile(join(root, 'other.txt'), 'other NEEDLE\n');
});
afterEach(async () => {
  try { await releaseNativeToolOwner('grep-native-test'); }
  finally { await rm(root, { recursive: true, force: true }); }
});

async function executable(body: string, mode = 0o755): Promise<ToolContext> {
  const path = join(root, 'search fixture');
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, mode);
  const ctx = context();
  ctx.env = { AGENT_RIPGREP_PATH: path };
  return ctx;
}

describe('Grep native facade', () => {
  it('treats successful empty stdout as no matches', async () => {
    const ctx = await executable('exit 0');
    const result = await tool().execute({ pattern: 'empty' }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('No matches found');
    expect(result.content).toContain('empty');
  });

  it('does not confuse exit code 12 with the no-match status', async () => {
    const ctx = await executable("printf 'fixture failed' >&2; exit 12");
    const result = await tool().execute({ pattern: 'needle' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('exit code 12');
    expect(result.content).toContain('fixture failed');
    expect(result.content).not.toContain('No matches found');
  });

  it('does not confuse not-found stderr with executable startup failure', async () => {
    const ctx = await executable("printf 'search input not found: missing-file' >&2; exit 2");
    const result = await tool().execute({ pattern: 'needle' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('exit code 2');
    expect(result.content).toContain('search input not found');
    expect(result.content).not.toContain('session PATH');
    expect(result.content).not.toContain('not installed');
  });

  it('keeps nonmissing startup permission errors distinct from executable absence', async () => {
    const ctx = await executable('exit 0', 0o644);
    const result = await tool().execute({ pattern: 'private-pattern' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Grep failed');
    expect(result.content).not.toContain('session PATH');
    expect(result.content).not.toContain('not installed');
    expect(result.content).not.toContain('private-pattern');
  });

  it('exposes readonly metadata and the required pattern schema', () => {
    expect(tool().name).toBe('Grep');
    expect(tool().permissionLevel).toBe('readonly');
    expect(tool().description.length).toBeGreaterThan(10);
    expect((tool().inputSchema as { required: string[] }).required).toContain('pattern');
  });

  it.each([{}, { pattern: '' }])('rejects a missing or empty pattern: %j', async input => {
    const result = await tool().execute(input, context());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('pattern');
  });

  it('returns matching files by default, rooted at the session directory', async () => {
    const result = await tool().execute({ pattern: 'needle' }, context());
    expect(result.isError).toBe(false);
    expect(result.content).toContain(join(root, 'src', 'a.ts'));
    expect(result.content).toContain(join(root, 'src', 'b.tsx'));
    expect(result.content).not.toContain('other.txt');
    expect(result.content).not.toContain('Showing lines');
  });

  it.each(['src', () => join(root, 'src')])('searches relative and absolute explicit paths: %s', async path => {
    const result = await tool().execute({ pattern: 'needle', path: typeof path === 'function' ? path() : path }, context());
    expect(result.isError).toBe(false);
    expect(result.content).toContain(join(root, 'src', 'a.ts'));
  });

  it('returns counts rather than matching source text', async () => {
    const result = await tool().execute({ pattern: 'needle', output_mode: 'count' }, context());
    expect(result.isError).toBe(false);
    expect(result.content).toContain(`${join(root, 'src', 'a.ts')}:2`);
    expect(result.content).not.toContain('needle ONE');
  });

  it.each([true, false])('honors content line numbering: %s', async numbered => {
    const result = await tool().execute({ pattern: 'needle', path: 'src/a.ts', output_mode: 'content', '-n': numbered }, context());
    expect(result.isError).toBe(false);
    expect(result.content).toBe(numbered ? '2:needle ONE\n4:needle TWO' : 'needle ONE\nneedle TWO');
  });

  it('supports case-insensitive and multiline matching', async () => {
    const insensitive = await tool().execute({ pattern: 'needle', '-i': true }, context());
    expect(insensitive.isError).toBe(false);
    expect(insensitive.content).toContain('other.txt');
    const multiline = await tool().execute({ pattern: 'ONE.*after', multiline: true, output_mode: 'content' }, context());
    expect(multiline.isError).toBe(false);
    expect(multiline.content).toContain('needle ONE');
    expect(multiline.content).toContain('after');
  });

  it.each([{ '-C': 1 }, { context: 1 }, { '-A': 1, '-B': 1 }])('preserves surrounding context: %j', async flags => {
    const result = await tool().execute({ pattern: 'ONE', path: 'src/a.ts', output_mode: 'content', ...flags }, context());
    expect(result.isError).toBe(false);
    expect(result.content).toBe('1-before\n2:needle ONE\n3-after');
  });

  it.each([{ glob: '*.tsx' }, { type: 'ts' }])('applies glob and expanded type filters: %j', async filter => {
    const result = await tool().execute({ pattern: 'needle', '-i': true, ...filter }, context());
    expect(result.isError).toBe(false);
    expect(result.content).toContain('b.tsx');
    expect(result.content).not.toContain('other.txt');
    if ('glob' in filter) expect(result.content).not.toContain('a.ts');
    else expect(result.content).toContain('a.ts');
  });

  it('treats a flag-shaped pattern as data', async () => {
    await writeFile(join(root, 'flag.txt'), '--needle\n');
    const result = await tool().execute({ pattern: '--needle' }, context());
    expect(result.isError).toBe(false);
    expect(result.content).toContain('flag.txt');
  });

  it('reports no matches with the pattern', async () => {
    const result = await tool().execute({ pattern: 'xyzNoMatch' }, context());
    expect(result.isError).toBe(false);
    expect(result.content).toContain('No matches found');
    expect(result.content).toContain('xyzNoMatch');
  });

  it('paginates matching lines and retains the total', async () => {
    const result = await tool().execute({ pattern: 'needle', path: 'src/a.ts', output_mode: 'content', offset: 1, head_limit: 1 }, context());
    expect(result.isError).toBe(false);
    expect(result.content).toContain('4:needle TWO');
    expect(result.content).not.toContain('needle ONE');
    expect(result.content).toContain('Showing lines 2-2 of 2');
    expect(result.content).toContain('offset=2');
  });

  it('defaults to 250 entries and permits an unlimited line window', async () => {
    await writeFile(join(root, 'many.txt'), 'needle\n'.repeat(300));
    const input = { pattern: 'needle', path: 'many.txt', output_mode: 'content' };
    const limited = await tool().execute(input, context());
    expect(limited.isError).toBe(false);
    expect(limited.content).toContain('Showing lines 1-250 of 300');
    const unlimited = await tool().execute({ ...input, head_limit: 0 }, context());
    expect(unlimited.isError).toBe(false);
    expect((unlimited.content as string).split('\n')).toHaveLength(300);
    expect(unlimited.content).not.toContain('Showing lines');
  });

  it('bounds oversized output with an explicit truncation notice', async () => {
    await writeFile(join(root, 'large.txt'), 'a'.repeat(101_000));
    const result = await tool().execute({ pattern: 'a', path: 'large.txt', output_mode: 'content', head_limit: 0 }, context());
    expect(result.isError).toBe(false);
    expect((result.content as string).length).toBeLessThan(101_100);
    expect(result.content).toContain('truncated');
  });

  it('reports cancellation without returning matches', async () => {
    const ctx = context();
    const controller = new AbortController();
    controller.abort();
    ctx.abortSignal = controller.signal;
    const result = await tool().execute({ pattern: 'needle' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('aborted');
  });

  it('keeps process failures distinct from a missing executable', async () => {
    const result = await tool().execute({ pattern: '[', path: 'src/a.ts' }, context());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('exit code 2');
    expect(result.content).not.toContain('session PATH');
    expect(result.content).not.toContain('not installed');
  });
});
