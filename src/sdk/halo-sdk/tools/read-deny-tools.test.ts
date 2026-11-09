/**
 * Read, Glob and Grep against real files, with `Read(...)` deny rules in force.
 * Grep runs the real ripgrep (skipped when `rg` is not on PATH): what matters is
 * that rg itself never opens a denied path, so no result window, paging note
 * or truncation can depend on what a denied file holds.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ReadTool } from './read/index.js';
import { GlobTool } from './glob/index.js';
import { GrepTool } from './grep/index.js';
import { resolveReadDenyRoots } from '../utils/read-deny.js';
import type { ToolContext } from '../types/tool.js';

const hasRg = spawnSync('rg', ['--version']).status === 0;

let tmp: string;
let ws: string;
let alias: string;
let ctx: ToolContext;
let openCtx: ToolContext;

function makeCtx(cwd: string, readDenyRoots: string[]): ToolContext {
  return {
    sessionId: 'read-deny',
    cwd,
    abortSignal: new AbortController().signal,
    costTracker: {} as ToolContext['costTracker'],
    currentTurn: 0,
    env: {},
    readDenyRoots,
  };
}

const text = (r: { content: unknown }) =>
  typeof r.content === 'string' ? r.content : JSON.stringify(r.content);

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'read-deny-tools-')));
  ws = path.join(tmp, 'ws');
  const write = (rel: string, body: string) => {
    const p = path.join(ws, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  write('.halo/apps/dh/runs/chat-alice.jsonl', 'phone SECRET-13800001234\n');
  write('.halo/apps/dh/memory/topics/t.md', 'note SECRET-MEM\n');
  write('.halo/state.json', 'SECRET-STATE\n');
  write('src/a.ts', 'visible SECRET-SRC\n');
  alias = path.join(tmp, 'alias');
  fs.symlinkSync(ws, alias);

  const rules = [
    `Read(/${path.join(ws, '.halo', 'apps', 'dh', 'runs')}/**)`,
    `Read(/${path.join(ws, '.halo', 'state.json')})`,
  ];
  ctx = makeCtx(ws, resolveReadDenyRoots(rules, ws));
  openCtx = makeCtx(ws, []);
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Read', () => {
  it('refuses a denied file however it is spelled', async () => {
    for (const p of [
      path.join(ws, '.halo/apps/dh/runs/chat-alice.jsonl'),
      path.join(alias, '.halo/apps/dh/runs/chat-alice.jsonl'),
      '.halo/apps/dh/../dh/runs/chat-alice.jsonl',
    ]) {
      const r = await new ReadTool().execute({ file_path: p }, ctx);
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('has been denied');
    }
  });

  it('reads an open file, and everything when no rule applies', async () => {
    expect(text(await new ReadTool().execute({ file_path: 'src/a.ts' }, ctx))).toContain('SECRET-SRC');
    const r = await new ReadTool().execute({ file_path: '.halo/apps/dh/runs/chat-alice.jsonl' }, openCtx);
    expect(text(r)).toContain('SECRET-13800001234');
  });
});

describe('Glob', () => {
  it('leaves denied paths out of a recursive walk and keeps the rest', async () => {
    for (const base of [ws, alias, `${ws}/./`, `${ws}/src/..`]) {
      const out = text(await new GlobTool().execute({ pattern: '**/*', path: base }, ctx));
      expect(out).not.toContain('chat-alice');
      expect(out).not.toContain('state.json');
      expect(out).toContain('t.md');
      expect(out).toContain('a.ts');
    }
  });

  it('refuses a walk that starts inside a denied folder', async () => {
    const r = await new GlobTool().execute({ pattern: '*', path: path.join(alias, '.halo/apps/dh/runs') }, ctx);
    expect(r.isError).toBe(true);
  });

  it('is unchanged without rules', async () => {
    const out = text(await new GlobTool().execute({ pattern: '**/*', path: ws }, openCtx));
    expect(out).toContain('chat-alice');
  });
});

describe.skipIf(!hasRg)('Grep (real ripgrep)', () => {
  const grep = (input: Record<string, unknown>, c = ctx) => new GrepTool().execute(input, c).then(text);

  it('never opens a denied file, whatever glob, path spelling or output mode', async () => {
    for (const p of [undefined, ws, alias, `${alias}/./`, `${ws}//`, `${ws}/src/..`]) {
      for (const glob of [undefined, '*', '**', '{.halo,*}', '.halo/**', '**/runs/**']) {
        for (const output_mode of ['content', 'files_with_matches', 'count']) {
          const out = await grep({ pattern: 'SECRET', path: p, glob, output_mode });
          expect(out, `${p} ${glob} ${output_mode}`).not.toMatch(/13800001234|chat-alice|SECRET-STATE|state\.json/);
        }
      }
    }
  });

  it('keeps open files, including hidden ones a glob reaches', async () => {
    const out = await grep({ pattern: 'SECRET', path: ws, glob: '*', output_mode: 'content' });
    expect(out).toContain('SECRET-MEM');
    expect(out).toContain('SECRET-SRC');
  });

  it('gives a denied match no say in the window: same output with and without it', async () => {
    // One visible line; a hidden match would take the second place of a
    // two-line window and change the paging note if it were ever collected.
    const hit = await grep({ pattern: 'SECRET-138|SECRET-MEM', glob: '*', output_mode: 'content', head_limit: 1 });
    const miss = await grep({ pattern: 'SECRET-139|SECRET-MEM', glob: '*', output_mode: 'content', head_limit: 1 });
    expect(hit).toBe(miss);
    const hit2 = await grep({ pattern: 'SECRET-138|SECRET-MEM', glob: '*', output_mode: 'count', head_limit: 1 });
    const miss2 = await grep({ pattern: 'SECRET-139|SECRET-MEM', glob: '*', output_mode: 'count', head_limit: 1 });
    expect(hit2).toBe(miss2);
  });

  it('refuses a search that starts inside a denied folder', async () => {
    expect(await grep({ pattern: 'x', path: path.join(alias, '.halo/apps/dh/runs') })).toContain('has been denied');
  });

  it('is unchanged without rules', async () => {
    const out = await grep({ pattern: 'SECRET', path: ws, glob: '*', output_mode: 'content' }, openCtx);
    expect(out).toContain('13800001234');
    expect(out.startsWith(ws)).toBe(true);
  });
});
