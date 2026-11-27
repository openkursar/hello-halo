import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { getAllTools, releaseNativeToolOwner } from '../../../native/tools.js';
import type { ToolContext } from '../../../types/tool.js';

let root: string;
let context: ToolContext;
const grep = (pattern: string, env: ToolContext['env'] = {}, path = 'lines.txt') =>
  getAllTools().find(tool => tool.name === 'Grep')!.execute({ pattern, path, output_mode: 'content', '-n': false }, { ...context, env: { AGENT_RIPGREP_PATH: undefined, ...env } });

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'rg-pattern-')));
  context = { cwd: root, env: {}, sessionId: root, currentTurn: 0, abortSignal: new AbortController().signal, costTracker: {} as ToolContext['costTracker'] };
  await writeFile(join(root, 'lines.txt'), 'needle\nneedle\r\n$\r\nR\r\n]$\r\n[\r\n');
});
afterEach(async () => { await releaseNativeToolOwner(root); await rm(root, { recursive: true, force: true }); });

const installations = [{ label: 'installed rg', executable: process.env.HALO_TEST_RIPGREP_CURRENT || 'rg' },
  ...(process.env.HALO_TEST_RIPGREP_13 ? [{ label: 'rg13', executable: process.env.HALO_TEST_RIPGREP_13 }] : [])];
for (const { label, executable } of installations) {
  describe(label, () => {
    it('preserves class literals, negations, escaped dollars and x-mode comments across line endings', async () => {
      const version = execFileSync(executable, ['--version'], { encoding: 'utf8' }).split('\n')[0];
      if (label === 'rg13') expect(version).toMatch(/^ripgrep 13\./);
      const supports = Number(/^ripgrep (\d+)/.exec(version)?.[1]) >= 14;
      const env = executable === 'rg' ? {} : { AGENT_RIPGREP_PATH: executable };
      for (const pattern of ['^needle$', '(?x) ^needle # [ \\r $\n $']) {
        expect(await grep(pattern, env)).toMatchObject({ isError: false, content: supports ? 'needle\nneedle' : 'needle' });
      }
      expect(await grep('^needle\\r?$', env)).toMatchObject({ isError: false, content: 'needle\nneedle' });
      for (const pattern of ['[]$]', '[^]$]', '\\$', '[[$]&&[$]]', '[]$]$', '[^]$]$', '(?x) [ $ ] \\$']) {
        const original = supports && ['[]$]$', '[^]$]$'].includes(pattern) ? `${pattern.slice(0, -1)}(?R:$)` : pattern;
        let expected: string;
        try { expected = execFileSync(executable, ['--no-config', '--', original, join(root, 'lines.txt')], { encoding: 'utf8' }).replace(/\r\n/g, '\n').replace(/\n$/, ''); }
        catch (error) { if ((error as { status?: number }).status !== 1) throw error; expected = ''; }
        const result = await grep(pattern, env);
        expect(result.isError, pattern).toBe(false);
        if (expected) expect(result.content, pattern).toBe(expected);
        else expect(result.content, pattern).toContain('No matches found');
      }
      for (const pattern of ['needle$(', '\\p{not_a_property}$']) {
        const invalid = await grep(pattern, env);
        expect(invalid.isError).toBe(true);
        expect(invalid.content).toContain(pattern);
        expect(invalid.content).not.toContain('(?R:$)');
      }
    });
  });
}

it('passes anchors unchanged to session-dependent launchers without probing them', async () => {
  const directory = join(root, 'launcher');
  await mkdir(directory);
  const script = join(directory, 'dispatch.cjs');
  const log = join(directory, 'calls.jsonl');
  await writeFile(script, `const fs = require('node:fs'); const {spawnSync} = require('node:child_process');
const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
const result=spawnSync(process.env.RG_FIXTURE_ENGINE || ${JSON.stringify(process.env.HALO_TEST_RIPGREP_CURRENT || 'rg')},args,{stdio:'inherit'});
process.exitCode=result.status ?? 3;`);
  const win = process.platform === 'win32';
  const program = join(directory, win ? 'rg.cmd' : 'rg');
  if (win) await writeFile(program, `@echo off\r\n"${process.execPath}" "%~dp0dispatch.cjs" %*\r\n`);
  else { await writeFile(program, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`); await chmod(program, 0o700); }
  const engine = process.env.HALO_TEST_RIPGREP_13 || process.env.HALO_TEST_RIPGREP_CURRENT || 'rg';
  const result = await grep('^needle$', { AGENT_RIPGREP_PATH: program, RG_FIXTURE_ENGINE: engine });
  expect(result).toMatchObject({ isError: false, content: 'needle' });
  const events = (await readFile(log, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  expect(events).toHaveLength(1);
  expect(events[0].at(-2)).toBe('^needle$');
});
