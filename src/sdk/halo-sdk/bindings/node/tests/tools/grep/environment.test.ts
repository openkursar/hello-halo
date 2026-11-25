import { afterEach, describe, expect, it } from 'vitest';
import { access, chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { getAllTools, releaseNativeToolOwner } from '../../../native/tools.js';
import type { ToolContext } from '../../../types/tool.js';

afterEach(async () => { await releaseNativeToolOwner('grep-environment-test'); });
describe('Grep environment boundary', () => {
  it('does not mutate caller environment objects when overrides remove inherited variables', async () => {
    const env = Object.freeze({ AGENT_RIPGREP_PATH: undefined, PATH: '' });
    const before = process.env.PATH;
    const ctx: ToolContext = { cwd: process.cwd(), env, sessionId: 'grep-environment-test', currentTurn: 0,
      abortSignal: new AbortController().signal, costTracker: {} as ToolContext['costTracker'] };
    const result = await getAllTools().find(tool => tool.name === 'Grep')!.execute({ pattern: 'needle' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('session PATH');
    expect(result.content).toContain('ripgrep');
    expect(result.content).toContain('Glob');
    expect(result.content).not.toContain('brew install');
    expect(env).toEqual({ AGENT_RIPGREP_PATH: undefined, PATH: '' });
    expect(process.env.PATH).toBe(before);
  });

  it('runs the ripgrep executable supplied by the session PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session rg '));
    try {
      const windows = process.platform === 'win32';
      const bin = join(root, 'session bin with spaces');
      const cwd = join(root, 'workspace');
      await Promise.all([mkdir(bin), mkdir(cwd)]);
      await writeFile(join(cwd, 'sample.txt'), 'session-ripgrep-marker\n');
      const tool = getAllTools().find(tool => tool.name === 'Grep')!;
      const ctx: ToolContext = { cwd, env: { AGENT_RIPGREP_PATH: undefined, PATH: bin, PATHEXT: 'CMD;EXE' },
        sessionId: 'grep-environment-test', currentTurn: 0, abortSignal: new AbortController().signal,
        costTracker: {} as ToolContext['costTracker'] };
      if (windows) {
        await writeFile(join(cwd, 'rg.cmd'), '@echo cwd-ripgrep-marker\r\n');
        await writeFile(join(bin, 'rg.cmd'), '@echo session-shim-marker\r\n');
        const missing = await tool.execute({ pattern: 'needle' }, ctx);
        expect(missing).toMatchObject({ isError: true, content: expect.stringContaining('session PATH') });
        for (const directory of (process.env.PATH ?? '').split(delimiter).map(path => path.replace(/^"|"$/g, '')).filter(isAbsolute)) {
          const candidate = join(directory, 'rg.exe');
          if (await access(candidate).then(() => true, () => false)) {
            await copyFile(candidate, join(bin, 'rg.exe'));
            break;
          }
        }
        await expect(access(join(bin, 'rg.exe')), 'Windows CI must provide ripgrep').resolves.toBeUndefined();
      } else {
        const executable = join(bin, 'rg');
        await writeFile(join(cwd, 'rg'), '#!/bin/sh\nprintf "cwd-ripgrep-marker\\n"\n');
        await chmod(join(cwd, 'rg'), 0o700);
        await writeFile(executable, '#!/bin/sh\nprintf "session-ripgrep-marker\\n"\n');
        await chmod(executable, 0o700);
      }
      const result = await tool.execute({ pattern: 'session-ripgrep-marker', path: join(cwd, 'sample.txt'), output_mode: 'content', '-n': false }, ctx);
      expect(result).toMatchObject({ isError: false, content: 'session-ripgrep-marker' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
