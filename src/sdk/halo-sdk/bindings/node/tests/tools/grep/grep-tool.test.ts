import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, chmod, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
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
  const script = join(root, 'search fixture.cjs');
  await writeFile(script, `#!/usr/bin/env node\n${body}\n`);
  let path = script;
  if (process.platform === 'win32') {
    path = join(root, 'search fixture.cmd');
    await writeFile(path, `@echo off\r\n"${process.execPath}" "%~dp0search fixture.cjs"\r\n`);
  } else {
    await chmod(script, mode);
  }
  const ctx = context();
  ctx.env = { AGENT_RIPGREP_PATH: path };
  return ctx;
}

describe('Grep native facade', () => {
  it('reports exit zero without stdout without claiming the search found nothing', async () => {
    const result = await tool().execute({ pattern: 'empty' }, await executable(''));
    expect(result.isError).toBe(false);
    expect(result.content).toContain('reported a match');
    expect(result.content).not.toContain('No matches');
  });

  it('searches an explicit file regardless of type and respects its glob', async () => {
    const input = { pattern: 'needle', path: 'src/a.ts' };
    const typed = await tool().execute({ ...input, type: 'ps' }, context());
    expect(typed).toMatchObject({ isError: false, content: join(root, 'src', 'a.ts') });
    for (const glob of ['*.ps1', '!src']) {
      const excluded = await tool().execute({ ...input, glob }, context());
      expect(excluded.content).toContain('not searched');
    }
    for (const glob of ['*.ts', 'src/*.ts']) {
      const included = await tool().execute({ ...input, glob }, context());
      expect(included).toMatchObject({ isError: false, content: join(root, 'src', 'a.ts') });
    }
  });

  it('keeps a successful whitespace-only match distinct from no matches', async () => {
    await writeFile(join(root, 'spaces.txt'), '   \n');
    const result = await tool().execute({ pattern: '^ +$', path: 'spaces.txt', output_mode: 'content', '-n': false }, context());
    expect(result).toMatchObject({ isError: false, content: '   ' });
    await writeFile(join(root, 'blank.txt'), '\n');
    const blank = await tool().execute({ pattern: '^$', path: 'blank.txt', output_mode: 'content', '-n': false }, context());
    expect(blank).toMatchObject({ isError: false, content: 'The matching line is empty.' });
  });

  it('ignores the user ripgrep configuration', async () => {
    const config = join(root, 'rg.conf');
    await writeFile(config, '--quiet\n');
    const ctx = context();
    ctx.env.RIPGREP_CONFIG_PATH = config;
    const result = await tool().execute({ pattern: 'needle' }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain(join(root, 'src', 'a.ts'));
  });

  it('matches the end of a line in both CRLF and LF files', async () => {
    for (const [name, ending] of [['dos.txt', '\r\n'], ['unix.txt', '\n']]) {
      await writeFile(join(root, name), `anchored${ending}`);
    }
    const result = await tool().execute({ pattern: '^anchored$' }, context());
    expect(result.isError).toBe(false);
    expect(result.content.split('\n').sort()).toEqual(['dos.txt', 'unix.txt'].map(name => join(root, name)));
  });

  it.each(['needle\\r?$', '\\r$', '[\\r]', '\\x0D', '\\x{d}', '\\u000d', '\\U0000000D', '\r'])('preserves explicit CR in %j', async pattern => {
    await writeFile(join(root, 'dos.txt'), 'needle\r\n');
    for (const multiline of [false, true]) {
      const result = await tool().execute({ pattern, multiline, path: 'dos.txt' }, context());
      expect(result).toMatchObject({ isError: false, content: join(root, 'dos.txt') });
    }
  });

  it('treats a lone CR as data for dots, including before a CRLF line anchor', async () => {
    await writeFile(join(root, 'mixed.txt'), 'foo\rbar\r\n');
    for (const pattern of ['foo.bar', '^foo.bar$']) {
      const result = await tool().execute({ pattern, path: 'mixed.txt' }, context());
      expect(result).toMatchObject({ isError: false, content: join(root, 'mixed.txt') });
    }
  });

  it('changes line-end assertions without changing caret, literal dollar, or dot semantics', async () => {
    await writeFile(join(root, 'mixed.txt'), 'foo\rbar\n$1\r\n');
    for (const pattern of ['[$]1$', '\\$1$']) {
      const result = await tool().execute({ pattern, path: 'mixed.txt' }, context());
      expect(result).toMatchObject({ isError: false, content: join(root, 'mixed.txt') });
    }
    const unrelated = await tool().execute({ pattern: '^bar$', path: 'mixed.txt' }, context());
    expect(unrelated.content).toContain('No matches found');
  });

  it('keeps real anchors after x-mode comments and reports invalid patterns', async () => {
    const path = join(root, 'comments.txt');
    await writeFile(path, 'needle\r\nneedle#\r\n');
    for (const pattern of ['(?x)^needle # [ \\r $\n $', '(?x:^needle # [ \\r $\n)#$']) {
      expect(await tool().execute({ pattern, path }, context())).toMatchObject({ isError: false, content: path });
    }
    const invalid = await tool().execute({ pattern: '(?x)needle$(', path }, context());
    expect(invalid.isError).toBe(true);
    expect(invalid.content).toContain('rg exit code 2');
  });

  it('does not invent a relative directory for a file outside the search cwd', async () => {
    const file = join(root, 'src', 'a.ts');
    const ctx = { ...context(), cwd: join(root, 'neighbour') };
    await mkdir(ctx.cwd);
    const result = await tool().execute({ pattern: 'needle', path: file, glob: 'src/*.ts' }, ctx);
    expect(result).toMatchObject({ isError: false, content: file });
  });

  it('combines a native file type with an exclusion glob', async () => {
    await writeFile(join(root, 'src', 'a.test.ts'), 'needle');
    await writeFile(join(root, 'also.txt'), 'needle');
    const result = await tool().execute({ pattern: 'needle', type: 'ts', glob: '!*.test.ts' }, context());
    expect(result.isError).toBe(false);
    expect(result.content.split('\n').sort()).toEqual(['a.ts', 'b.tsx'].map(name => join(root, 'src', name)));
  });

  it('filters by native file types and rejects unknown types', async () => {
    const ps = join(root, 'tool.ps1');
    await writeFile(ps, 'needle');
    const result = await tool().execute({ pattern: 'needle', type: 'ps' }, context());
    expect(result).toMatchObject({ isError: false, content: ps });
    const invalid = await tool().execute({ pattern: 'needle', type: 'unknownhalotype' }, context());
    expect(invalid.isError).toBe(true);
    expect(invalid.content).toContain('unknownhalotype');
  });

  it('uses a positive glob in preference to type without changing the output format', async () => {
    const file = join(root, 'selected.txt');
    await writeFile(file, 'needle\n');
    for (const output_mode of ['files_with_matches', 'content', 'count']) {
      const input = { pattern: 'needle', glob: '*.txt', output_mode };
      const byGlob = await tool().execute(input, context());
      expect(byGlob.isError).toBe(false);
      expect(byGlob.content).toContain('selected.txt');
      expect(byGlob.content).not.toContain('a.ts');
      const combined = await tool().execute({ ...input, type: 'ts' }, context());
      expect(combined).toEqual(byGlob);
    }
    const absent = await tool().execute({ pattern: 'missing', glob: '*.txt', type: 'ts' }, context());
    expect(absent.isError).toBe(false);
    expect(absent.content).toContain('with glob "*.txt" and type "ts"');
    const invalid = await tool().execute({ pattern: 'needle', glob: '*.txt', type: 'unknownhalotype' }, context());
    expect(invalid.isError).toBe(true);
    expect(invalid.content).toContain('unknownhalotype');
  });

  it.runIf(process.platform === 'win32')('accepts Windows path separators in a glob', async () => {
    const result = await tool().execute({ pattern: 'needle', glob: 'src\\*.ts' }, context());
    expect(result).toMatchObject({ isError: false, content: join(root, 'src', 'a.ts') });
  });

  it('keeps matches and the stderr reason when rg exits 2', async () => {
    const ctx = await executable("console.log('found.ts'); console.error('permission denied'); process.exitCode = 2;");
    const result = await tool().execute({ pattern: 'needle' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/^Incomplete search:.*permission denied\n\nfound\.ts$/);
  });

  it.each([false, true])('bounds error details while retaining matches and an exact omitted count (matches=%s)', async matches => {
    const ctx = await executable(`
      if (${matches}) console.log('first-hit.ts');
      for (let i = 0; i < 800; i++) console.error('unreadable-' + i + ': ' + 'x'.repeat(i === 0 ? 90_000 : 200));
      process.exitCode = 2;
    `);
    const result = await tool().execute({ pattern: 'needle' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content.length).toBeLessThan(5_000);
    expect(result.content).toContain('unreadable-0:');
    expect(result.content).toContain('unreadable-2:');
    expect(result.content).toContain('+797 more');
    expect(result.content).not.toContain('unreadable-3:');
    if (matches) expect(result.content).toContain('first-hit.ts');
  });

  it('decodes a UTF-8 path across pipe writes', async () => {
    const ctx = await executable("process.stdout.write(Buffer.from([0xe4])); setTimeout(() => process.stdout.write(Buffer.concat([Buffer.from([0xb8, 0xad]), Buffer.from('.txt\\n')])), 100);");
    expect(await tool().execute({ pattern: 'needle' }, ctx)).toMatchObject({ isError: false, content: '中.txt' });
  });

  it('does not confuse exit code 12 with the no-match status', async () => {
    const ctx = await executable("console.error('fixture failed'); process.exitCode = 12;");
    const result = await tool().execute({ pattern: 'needle' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('exit code 12');
    expect(result.content).toContain('fixture failed');
    expect(result.content).not.toContain('No matches found');
  });

  it('does not confuse not-found stderr with executable startup failure', async () => {
    const ctx = await executable("console.error('search input not found: missing-file'); process.exitCode = 2;");
    const result = await tool().execute({ pattern: 'needle' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('exit code 2');
    expect(result.content).toContain('search input not found');
    expect(result.content).not.toContain('session PATH');
    expect(result.content).not.toContain('not installed');
  });

  it.skipIf(process.platform === 'win32')('keeps POSIX startup permission errors distinct from executable absence', async () => {
    const ctx = await executable('', 0o644);
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

  it.skipIf(process.platform === 'win32')('honors cancellation after stdout closes but before the search exits', async () => {
    const ready = join(root, 'stdout-closed');
    const ctx = await executable(`
      const fs = require('node:fs');
      fs.closeSync(1);
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
      setTimeout(() => process.exit(1), 1500);
    `);
    const controller = new AbortController();
    ctx.abortSignal = controller.signal;
    const pending = tool().execute({ pattern: 'needle' }, ctx);
    try {
      await vi.waitFor(() => access(ready), { timeout: 4000 });
      controller.abort();
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(result.content).toContain('aborted');
      expect(result.content).not.toContain('No matches');
    } finally {
      controller.abort();
      await pending;
    }
  });

  it('keeps process failures distinct from a missing executable', async () => {
    const result = await tool().execute({ pattern: '[', path: 'src/a.ts' }, context());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('exit code 2');
    expect(result.content).not.toContain('session PATH');
    expect(result.content).not.toContain('not installed');
  });
});
