import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveReadDenyRoots,
  isReadDenied,
  isDeniedReal,
  deniedBelow,
  realPath,
} from './read-deny.js';

let tmp: string;
let ws: string;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'read-deny-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(ws, '.halo', 'runs'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.halo', 'runs', 'chat.jsonl'), 'x');
  fs.symlinkSync(ws, path.join(tmp, 'alias'));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('resolveReadDenyRoots', () => {
  it('reads absolute, home and relative rule paths; ignores other entries', () => {
    const roots = resolveReadDenyRoots(
      ['Bash', 'Read', `Read(/${ws}/.halo/runs/**)`, 'Read(~/secret)', 'Read(src/private)', 'Edit(//x)'],
      ws,
    );
    expect(roots).toEqual([
      path.join(ws, '.halo', 'runs'),
      path.join(os.homedir(), 'secret'),
      path.join(ws, 'src', 'private'),
    ]);
  });

  it('skips a rule holding a wildcard instead of widening it', () => {
    expect(resolveReadDenyRoots(['Read(*.env)', `Read(/${ws}/**/x)`], ws)).toEqual([]);
  });

  it('resolves links, so a rule and a path spelled through a link agree', () => {
    const [root] = resolveReadDenyRoots([`Read(/${path.join(tmp, 'alias', '.halo')}/**)`], ws);
    expect(root).toBe(path.join(ws, '.halo'));
  });

  it('returns nothing without rules', () => {
    expect(resolveReadDenyRoots(undefined, ws)).toEqual([]);
    expect(resolveReadDenyRoots([], ws)).toEqual([]);
  });
});

describe('isReadDenied', () => {
  const roots = () => [path.join(ws, '.halo', 'runs')];

  it('denies the root and everything below it, and nothing beside it', () => {
    expect(isReadDenied(path.join(ws, '.halo', 'runs'), roots())).toBe(true);
    expect(isReadDenied(path.join(ws, '.halo', 'runs', 'chat.jsonl'), roots())).toBe(true);
    expect(isReadDenied(path.join(ws, '.halo', 'runs-other'), roots())).toBe(false);
    expect(isReadDenied(path.join(ws, 'src'), roots())).toBe(false);
  });

  it('sees through links and lexical detours', () => {
    expect(isReadDenied(path.join(tmp, 'alias', '.halo', 'runs', 'chat.jsonl'), roots())).toBe(true);
    expect(isReadDenied(`${ws}/src/../.halo/./runs`, roots())).toBe(true);
  });

  it.skipIf(process.platform !== 'darwin' && process.platform !== 'win32')(
    'ignores case where the filesystem does',
    () => {
      expect(isDeniedReal(path.join(ws, '.HALO', 'Runs'), roots())).toBe(true);
    },
  );
});

describe('deniedBelow', () => {
  it('lists denied roots strictly below a folder, relative and with / separators', () => {
    const roots = [path.join(ws, '.halo', 'runs'), path.join(tmp, 'elsewhere'), ws];
    expect(deniedBelow(ws, roots)).toEqual(['.halo/runs']);
    expect(deniedBelow(path.join(ws, '.halo'), roots)).toEqual(['runs']);
    expect(deniedBelow(path.join(ws, 'src'), roots)).toEqual([]);
  });
});

describe('realPath', () => {
  it('resolves a path that does not exist yet through its nearest ancestor', () => {
    expect(realPath(path.join(tmp, 'alias', 'new', 'file'))).toBe(path.join(ws, 'new', 'file'));
  });
});
