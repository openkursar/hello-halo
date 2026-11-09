/**
 * @module tools/grep/grep-tool.test
 * Unit tests for GrepTool — uses mocked spawn so no system rg is required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ToolContext } from '../../types/tool.js';
import { CostTracker } from '../../core/cost.js';

// ---------------------------------------------------------------------------
// Mock node:child_process before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

// Import AFTER vi.mock so the module sees the mocked version.
import { spawn } from 'node:child_process';
import { GrepTool } from './index.js';
const mockSpawn = spawn as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MockProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock child process that behaves like spawn() returns. */
function makeMockProcess(): MockProcess {
  const proc = new EventEmitter() as MockProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

/** Configure spawn mock and emit stdout data + close event. */
function spawnSuccess(stdout: string, code = 0): MockProcess {
  const proc = makeMockProcess();
  mockSpawn.mockReturnValueOnce(proc as unknown as ReturnType<typeof spawn>);
  // Emit output asynchronously to simulate real child process
  setImmediate(() => {
    if (stdout) {
      proc.stdout.emit('data', Buffer.from(stdout));
    }
    proc.emit('close', code);
  });
  return proc;
}

/** Configure spawn mock to emit an ENOENT error. */
function spawnEnoent(): void {
  const proc = makeMockProcess();
  mockSpawn.mockReturnValueOnce(proc as unknown as ReturnType<typeof spawn>);
  setImmediate(() => {
    const err = new Error('spawn rg ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    proc.emit('error', err);
  });
}

/** Configure spawn mock to exit with a non-zero code and stderr. */
function spawnFailure(stderr: string, code: number): void {
  const proc = makeMockProcess();
  mockSpawn.mockReturnValueOnce(proc as unknown as ReturnType<typeof spawn>);
  setImmediate(() => {
    if (stderr) {
      proc.stderr.emit('data', Buffer.from(stderr));
    }
    proc.emit('close', code);
  });
}

function makeCtx(cwd?: string): ToolContext {
  return {
    sessionId: randomUUID(),
    cwd: cwd ?? os.tmpdir(),
    abortSignal: new AbortController().signal,
    costTracker: new CostTracker('test-model'),
    currentTurn: 0,
    env: {},
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// Metadata
// ===========================================================================

describe('GrepTool — metadata', () => {
  it('has name "Grep"', () => {
    expect(new GrepTool().name).toBe('Grep');
  });

  it('has permissionLevel "readonly"', () => {
    expect(new GrepTool().permissionLevel).toBe('readonly');
  });

  it('has an inputSchema with required pattern', () => {
    const schema = new GrepTool().inputSchema as Record<string, unknown>;
    expect((schema.required as string[]).includes('pattern')).toBe(true);
  });

  it('has a non-empty description', () => {
    expect(new GrepTool().description.length).toBeGreaterThan(10);
  });
});

// ===========================================================================
// Input validation
// ===========================================================================

describe('GrepTool — input validation', () => {
  it('returns error when pattern is missing', async () => {
    const tool = new GrepTool();
    const result = await tool.execute({}, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content as string).toContain('pattern');
  });

  it('returns error when pattern is empty string', async () => {
    const tool = new GrepTool();
    const result = await tool.execute({ pattern: '' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content as string).toContain('pattern');
  });
});

// ===========================================================================
// rg not installed
// ===========================================================================

describe('GrepTool — rg not installed', () => {
  it('reports unavailable search with tool fallbacks and no platform installer on ENOENT', async () => {
    spawnEnoent();
    const tool = new GrepTool();
    const result = await tool.execute({ pattern: 'foo' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content as string).toContain('ripgrep');
    expect(result.content as string).toContain('session PATH');
    expect(result.content as string).toContain('Glob');
    expect(result.content as string).not.toContain('brew install');
  });
});

// ===========================================================================
// No-match cases
// ===========================================================================

describe('GrepTool — no matches', () => {
  it('returns no-matches message when rg exits with code 1 (no matches)', async () => {
    spawnSuccess('', 1);
    const tool = new GrepTool();
    const result = await tool.execute({ pattern: 'xyzNoMatch' }, makeCtx());
    expect(result.isError).toBe(false);
    expect(result.content as string).toContain('No matches found');
    expect(result.content as string).toContain('xyzNoMatch');
  });

  it('returns no-matches message when rg outputs empty string with code 0', async () => {
    spawnSuccess('', 0);
    const tool = new GrepTool();
    const result = await tool.execute({ pattern: 'empty' }, makeCtx());
    expect(result.isError).toBe(false);
    expect(result.content as string).toContain('No matches found');
  });
});

// ===========================================================================
// Successful matches
// ===========================================================================

describe('GrepTool — successful matches', () => {
  it('returns matched output from rg stdout', async () => {
    spawnSuccess('src/foo.ts\nsrc/bar.ts\n');
    const tool = new GrepTool();
    const result = await tool.execute({ pattern: 'function' }, makeCtx());
    expect(result.isError).toBe(false);
    expect(result.content as string).toContain('src/foo.ts');
    expect(result.content as string).toContain('src/bar.ts');
  });

  it('defaults to files_with_matches mode (passes -l to rg)', async () => {
    spawnSuccess('src/index.ts\n');
    const tool = new GrepTool();
    await tool.execute({ pattern: 'foo' }, makeCtx());
    const args = (mockSpawn.mock.calls[0] as [string, string[]])[1];
    expect(args).toContain('-l');
  });

  it('passes -c flag for count mode', async () => {
    spawnSuccess('src/index.ts:42\n');
    const tool = new GrepTool();
    await tool.execute({ pattern: 'foo', output_mode: 'count' }, makeCtx());
    const args = (mockSpawn.mock.calls[0] as [string, string[]])[1];
    expect(args).toContain('-c');
    expect(args).not.toContain('-l');
  });

  it('passes -n flag for content mode (line numbers enabled by default)', async () => {
    spawnSuccess('5:const x = 1;\n');
    const tool = new GrepTool();
    await tool.execute({ pattern: 'const', output_mode: 'content' }, makeCtx());
    const args = (mockSpawn.mock.calls[0] as [string, string[]])[1];
    expect(args).toContain('-n');
    expect(args).not.toContain('-l');
    expect(args).not.toContain('-c');
  });

  it('does not pass -n for content mode when -n is explicitly false', async () => {
    spawnSuccess('const x = 1;\n');
    const tool = new GrepTool();
    await tool.execute({ pattern: 'const', output_mode: 'content', '-n': false }, makeCtx());
    const args = (mockSpawn.mock.calls[0] as [string, string[]])[1];
    expect(args).not.toContain('-n');
  });
});

// ===========================================================================
// Flag passthrough
// ===========================================================================

describe('GrepTool — flag passthrough', () => {
  it('passes -i for case insensitive search', async () => {
    spawnSuccess('');
    const tool = new GrepTool();
    await tool.execute({ pattern: 'FOO', '-i': true }, makeCtx());
    const args = (mockSpawn.mock.calls[0] as [string, string[]])[1];
    expect(args).toContain('-i');
  });

  it('passes -U --multiline-dotall for multiline mode', async () => {
    spawnSuccess('');
    const tool = new GrepTool();
    await tool.execute({ pattern: 'foo', multiline: true }, makeCtx());
    const args = (mockSpawn.mock.calls[0] as [string, string[]])[1];
    expect(args).toContain('-U');
    expect(args).toContain('--multiline-dotall');
  });

  it('passes -C for context shorthand', async () => {
    spawnSuccess('1: match\n2: line\n3: other\n');
    const tool = new GrepTool();
    await tool.execute({ pattern: 'match', output_mode: 'content', '-C': 2 }, makeCtx());
    const args = (mockSpawn.mock.calls[0] as [string, string[]])[1];
    const idx = args.indexOf('-C');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('2');
  });

  it('passes -C for context param (alias)', async () => {
    spawnSuccess('');
    const tool = new GrepTool();
    await tool.execute({ pattern: 'x', output_mode: 'content', context: 3 }, makeCtx());
    const args = (mockSpawn.mock.calls[0] as [string, string[]])[1];
    const idx = args.indexOf('-C');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('3');
  });

  it('passes -A and -B independently when -C is not set', async () => {
    spawnSuccess('');
    const tool = new GrepTool();
    await tool.execute({ pattern: 'x', output_mode: 'content', '-A': 2, '-B': 1 }, makeCtx());
    const args = (mockSpawn.mock.calls[0] as [string, string[]])[1];
    expect(args).toContain('-A');
    expect(args).toContain('-B');
    const idxA = args.indexOf('-A');
    expect(args[idxA + 1]).toBe('2');
    const idxB = args.indexOf('-B');
    expect(args[idxB + 1]).toBe('1');
  });

  it('passes --glob for glob filter', async () => {
    spawnSuccess('src/foo.ts\n');
    const tool = new GrepTool();
    await tool.execute({ pattern: 'fn', glob: '*.ts' }, makeCtx());
    const args = (mockSpawn.mock.calls[0] as [string, string[]])[1];
    const idx = args.indexOf('--glob');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('*.ts');
  });

  it('passes --glob for file type filter (ts → *.ts, *.tsx, etc.)', async () => {
    spawnSuccess('');
    const tool = new GrepTool();
    await tool.execute({ pattern: 'import', type: 'ts' }, makeCtx());
    const args = (mockSpawn.mock.calls[0] as [string, string[]])[1];
    const globIdx = args.indexOf('--glob');
    expect(globIdx).toBeGreaterThan(-1);
    // First --glob should expand the ts type
    const globValue = args[globIdx + 1];
    expect(globValue).toMatch(/\*\.(ts|tsx|mts|cts)/);
  });
});

// ===========================================================================
// Path resolution
// ===========================================================================

describe('GrepTool — path resolution', () => {
  it('defaults to ctx.cwd when no path is given', async () => {
    const cwd = '/some/project';
    spawnSuccess('');
    const tool = new GrepTool();
    await tool.execute({ pattern: 'x' }, makeCtx(cwd));
    const args = (mockSpawn.mock.calls[0] as [string, string[]])[1];
    // Pattern and path are always last (after --)
    expect(args[args.length - 1]).toBe(cwd);
  });

  it('uses absolute path as-is when given', async () => {
    const searchPath = '/absolute/path';
    spawnSuccess('');
    const tool = new GrepTool();
    await tool.execute({ pattern: 'x', path: searchPath }, makeCtx('/other'));
    const args = (mockSpawn.mock.calls[0] as [string, string[]])[1];
    expect(args[args.length - 1]).toBe(searchPath);
  });

  it('resolves relative path relative to ctx.cwd', async () => {
    spawnSuccess('');
    const tool = new GrepTool();
    await tool.execute({ pattern: 'x', path: 'src' }, makeCtx('/project'));
    const args = (mockSpawn.mock.calls[0] as [string, string[]])[1];
    expect(args[args.length - 1]).toBe('/project/src');
  });

  it('always passes -- before pattern and path', async () => {
    spawnSuccess('');
    const tool = new GrepTool();
    await tool.execute({ pattern: 'mypattern' }, makeCtx('/cwd'));
    const args = (mockSpawn.mock.calls[0] as [string, string[]])[1];
    const dashDash = args.indexOf('--');
    expect(dashDash).toBeGreaterThan(-1);
    expect(args[dashDash + 1]).toBe('mypattern');
  });
});

// ===========================================================================
// head_limit and offset
// ===========================================================================

describe('GrepTool — head_limit and offset', () => {
  it('limits output to head_limit lines and reports the window', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `file${i}.ts`).join('\n') + '\n';
    spawnSuccess(lines);
    const tool = new GrepTool();
    const result = await tool.execute({ pattern: 'x', head_limit: 5 }, makeCtx());
    const content = result.content as string;
    const [body, footer] = content.split('\n\n');
    const outputLines = body.split('\n');
    expect(outputLines).toHaveLength(5);
    expect(outputLines[0]).toBe('file0.ts');
    expect(outputLines[4]).toBe('file4.ts');
    expect(footer).toContain('Showing lines 1-5 of 20');
    expect(footer).toContain('offset=5');
  });

  it('skips first N lines with offset and reports the window', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `file${i}.ts`).join('\n') + '\n';
    spawnSuccess(lines);
    const tool = new GrepTool();
    const result = await tool.execute(
      { pattern: 'x', offset: 3, head_limit: 2 },
      makeCtx(),
    );
    const content = result.content as string;
    const [body, footer] = content.split('\n\n');
    const outputLines = body.split('\n');
    expect(outputLines).toHaveLength(2);
    expect(outputLines[0]).toBe('file3.ts');
    expect(outputLines[1]).toBe('file4.ts');
    expect(footer).toContain('Showing lines 4-5 of 10');
    expect(footer).toContain('offset=5');
  });

  it('applies default head_limit of 250 lines', async () => {
    const lines =
      Array.from({ length: 300 }, (_, i) => `file${i}.ts`).join('\n') + '\n';
    spawnSuccess(lines);
    const tool = new GrepTool();
    const result = await tool.execute({ pattern: 'x' }, makeCtx());
    const content = result.content as string;
    const [body, footer] = content.split('\n\n');
    expect(body.split('\n')).toHaveLength(250);
    expect(footer).toContain('Showing lines 1-250 of 300');
  });

  it('appends no pagination footer when all matches are shown', async () => {
    const lines = Array.from({ length: 3 }, (_, i) => `file${i}.ts`).join('\n') + '\n';
    spawnSuccess(lines);
    const tool = new GrepTool();
    const result = await tool.execute({ pattern: 'x' }, makeCtx());
    expect(result.content as string).not.toContain('Showing lines');
  });
});

// ===========================================================================
// Output truncation
// ===========================================================================

describe('GrepTool — output truncation', () => {
  it('truncates output that exceeds MAX_OUTPUT_SIZE', async () => {
    // 100_001 chars of output
    const bigOutput = 'a'.repeat(101_000) + '\n';
    spawnSuccess(bigOutput);
    const tool = new GrepTool();
    const result = await tool.execute(
      { pattern: 'a', head_limit: 0 },
      makeCtx(),
    );
    const content = result.content as string;
    expect(content.length).toBeLessThanOrEqual(101_000 + 100);
    expect(content).toContain('truncated');
  });
});

// ===========================================================================
// Abort signal
// ===========================================================================

describe('GrepTool — abort signal', () => {
  it('rejects immediately when signal is already aborted', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValueOnce(proc as unknown as ReturnType<typeof spawn>);
    // Emit close after a longer delay (would be too late)
    setTimeout(() => proc.emit('close', 0), 500);

    const controller = new AbortController();
    controller.abort(); // pre-aborted

    const ctx: ToolContext = {
      sessionId: randomUUID(),
      cwd: os.tmpdir(),
      abortSignal: controller.signal,
      costTracker: new CostTracker('test-model'),
      currentTurn: 0,
      env: {},
    };
    const tool = new GrepTool();
    const result = await tool.execute({ pattern: 'x' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content as string).toContain('aborted');
    // proc.kill should have been called
    expect(proc.kill).toHaveBeenCalled();
  });
});

// ===========================================================================
// Error handling
// ===========================================================================

describe('GrepTool — error handling', () => {
  it('returns error on rg exit code > 1', async () => {
    spawnFailure('fatal: permission denied', 2);
    const tool = new GrepTool();
    const result = await tool.execute({ pattern: 'x' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content as string).toContain('Grep failed');
  });
});

describe('GrepTool — executable and environment', () => {
  it('runs an absolute configured executable as one program name, including spaces', async () => {
    spawnSuccess('match\n');
    const ctx = makeCtx();
    ctx.env = { AGENT_RIPGREP_PATH: '/opt/host tools/ripgrep', GREP_TEST_ENV: 'session' };
    await new GrepTool().execute({ pattern: 'needle' }, ctx);
    expect(mockSpawn).toHaveBeenCalledWith('/opt/host tools/ripgrep', expect.any(Array), expect.objectContaining({
      env: expect.objectContaining({ GREP_TEST_ENV: 'session' }),
    }));
    expect(mockSpawn.mock.calls[0][2].env).not.toBe(ctx.env);
    expect(mockSpawn.mock.calls[0][2].env).not.toBe(process.env);
  });

  it('uses PATH when the configured override is relative', async () => {
    spawnSuccess('match\n');
    const ctx = makeCtx();
    ctx.env = { AGENT_RIPGREP_PATH: './tools/rg', PATH: '/session/bin' };
    await new GrepTool().execute({ pattern: 'needle' }, ctx);
    expect(mockSpawn.mock.calls[0][0]).toBe('rg');
    expect(mockSpawn.mock.calls[0][2].env.PATH).toBe('/session/bin');
  });

  it('reports a configured executable startup failure without retrying PATH', async () => {
    spawnEnoent();
    const ctx = makeCtx();
    ctx.env = { AGENT_RIPGREP_PATH: '/missing/host/rg' };
    const result = await new GrepTool().execute({ pattern: 'needle' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('configured ripgrep executable');
    expect(result.content).toContain('Glob');
    expect(result.content).not.toContain('session PATH');
    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it('does not mistake not-found text in process stderr for a missing executable', async () => {
    spawnFailure('search input not found: missing-file', 2);
    const result = await new GrepTool().execute({ pattern: 'needle' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('rg exit code 2');
    expect(result.content).toContain('search input not found');
    expect(result.content).not.toContain('session PATH');
    expect(result.content).not.toContain('not installed');
  });

  it('does not treat exit codes beginning with 1 as a no-match result', async () => {
    spawnFailure('fixture failed', 12);
    const result = await new GrepTool().execute({ pattern: 'needle' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('exit code 12');
  });

  it('keeps nonmissing startup errors distinct and logs only bounded metadata once', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const proc = makeMockProcess();
    mockSpawn.mockReturnValueOnce(proc);
    setImmediate(() => {
      proc.emit('error', Object.assign(new Error('fixture-secret permission denied'), { code: 'EACCES' }));
      proc.emit('close', -1);
    });
    const result = await new GrepTool().execute({ pattern: 'private-pattern' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain('not installed');
    expect(warning).toHaveBeenCalledOnce();
    const logged = warning.mock.calls.flat().join(' ');
    expect(logged).toContain('EACCES');
    expect(logged).not.toContain('fixture-secret');
    expect(logged).not.toContain('private-pattern');
  });
});
