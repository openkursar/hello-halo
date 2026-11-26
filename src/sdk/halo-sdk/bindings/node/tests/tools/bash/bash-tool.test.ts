import { describe, it, expect, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolContext } from '../../../types/tool.js';
import { CostTracker } from '../../../native/values.js';
import { getAllTools, releaseNativeToolOwner } from '../../../native/tools.js';

const sessionIds: string[] = [];
function makeCtx(sessionId = randomUUID()): ToolContext {
  sessionIds.push(sessionId);
  return { sessionId, cwd: tmpdir(), abortSignal: new AbortController().signal,
    costTracker: new CostTracker('test-model'), currentTurn: 0, env: {} };
}
const tool = () => getAllTools().find(candidate => candidate.name === 'Bash')!;
afterEach(async () => { await Promise.all(sessionIds.splice(0).map(releaseNativeToolOwner)); });

describe('Bash native facade', () => {
  it('returns error when command is missing', async () => {
    const result = await tool().execute({}, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('command');
  });
  it('returns error when command is not a string', async () => {
    expect((await tool().execute({ command: 42 }, makeCtx())).isError).toBe(true);
  });
  it('retains the Bash name and execute permission', () => {
    expect(tool().name).toBe('Bash');
    expect(tool().permissionLevel).toBe('execute');
  });
  it('executes a simple echo command', async () => {
    const result = await tool().execute({ command: 'echo hello' }, makeCtx());
    expect(result.isError).toBe(false);
    expect(result.content).toContain('hello');
  });
  it('reports non-UTF-8 output with a path to the original bytes', async () => {
    const result = await tool().execute({ command: "printf '\\326\\320\\316\\304'" }, makeCtx());
    expect(result.isError).toBe(false);
    const [text, notice, ...extraLines] = result.content.split('\n');
    expect(text).toBe('����');
    expect(extraLines).toEqual([]);
    const path = /^UTF-8 decoding was lossy; raw bytes \(combined stdout and stderr\): (.+)\.$/.exec(notice)?.[1];
    expect(path).toBeDefined();
    expect(await readFile(path!)).toEqual(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
  });
  it('returns toolError for non-zero exit code', async () => {
    const result = await tool().execute({ command: 'exit 42' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('42');
  });
  it('includes STDERR output in result', async () => {
    const result = await tool().execute({ command: 'echo error_message >&2' }, makeCtx());
    expect(result.isError).toBe(false);
    expect(result.content).toContain('error_message');
  });
  it('returns no-output feedback when command produces no output', async () => {
    const result = await tool().execute({ command: 'true' }, makeCtx());
    expect(result.isError).toBe(false);
    expect(result.content).toBe('(No output)');
  });
  it('handles multiline command output', async () => {
    const result = await tool().execute({ command: 'printf "line1\\nline2\\nline3"' }, makeCtx());
    expect(result.isError).toBe(false);
    for (const line of ['line1', 'line2', 'line3']) expect(result.content).toContain(line);
  });
  it('executes arithmetic via bash built-ins', async () => {
    const result = await tool().execute({ command: 'echo $((2 + 2))' }, makeCtx());
    expect(result.isError).toBe(false);
    expect(result.content.trim()).toBe('4');
  });
  it('reports an unknown executable as an execution failure', async () => {
    expect((await tool().execute({ command: '__nonexistent_cmd_xyz__' }, makeCtx())).isError).toBe(true);
  });
  it('tracks cwd changes across two calls', async () => {
    const ctx = makeCtx();
    const pwd = process.platform === 'win32' ? 'pwd -P -W' : 'pwd -P';
    const first = await tool().execute({ command: `cd /tmp; ${pwd}` }, ctx);
    expect(first.isError).toBe(false);
    const next = await tool().execute({ command: pwd }, ctx);
    expect(next.isError).toBe(false);
    expect(next.content.trim()).toBe(first.content.trim());
  });
  it('persists exported env vars across calls', async () => {
    const ctx = makeCtx();
    await tool().execute({ command: 'export MY_TEST_VAR=hello123' }, ctx);
    const result = await tool().execute({ command: 'echo $MY_TEST_VAR' }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content.trim()).toBe('hello123');
  });
  it('runs later commands in full however many variables and command text are carried over', async () => {
    const ctx = makeCtx();
    const exports = Array.from({ length: 150 }, (_, index) => `export CARRIED_VARIABLE_${index}=value-${index}`).join('; ');
    expect((await tool().execute({ command: exports }, ctx)).isError).toBe(false);
    const padding = 'x'.repeat(20_000);
    const result = await tool().execute({ command: `: ${padding}\nprintf '%s %s' "$CARRIED_VARIABLE_0 $CARRIED_VARIABLE_149" 'a\\\\b'` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content.trim()).toBe('value-0 value-149 a\\\\b');
  });
  it('isolates state between different sessions', async () => {
    await tool().execute({ command: 'export ISOLATED_VAR=from_A' }, makeCtx());
    const result = await tool().execute({ command: 'echo "${ISOLATED_VAR:-not_set}"' }, makeCtx());
    expect(result.isError).toBe(false);
    expect(result.content.trim()).toBe('not_set');
  });
  it('releases one owner without clearing another and release is idempotent', async () => {
    const first = makeCtx();
    const second = makeCtx();
    await tool().execute({ command: 'export OWNER_VALUE=first' }, first);
    await tool().execute({ command: 'export OWNER_VALUE=second' }, second);
    await releaseNativeToolOwner(first.sessionId);
    await releaseNativeToolOwner(first.sessionId);
    expect((await tool().execute({ command: 'echo "${OWNER_VALUE:-fresh}"' }, first)).content).toBe('fresh');
    expect((await tool().execute({ command: 'echo "$OWNER_VALUE"' }, second)).content).toBe('second');
  });
  it('handles a pre-aborted signal without hanging', async () => {
    const ctx = makeCtx();
    const controller = new AbortController(); controller.abort(); ctx.abortSignal = controller.signal;
    const result = await tool().execute({ command: 'echo should_abort' }, ctx);
    expect(typeof result.content).toBe('string');
  });
  it('preserves stdout and stderr captured before termination', async () => {
    const result = await tool().execute({ command: 'printf "Processed 12 items\\n"; printf "Checkpoint saved\\n" >&2; sleep 30', timeout: 300 }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('timed out after 300ms');
    expect(result.content).toContain('Processed 12 items');
    expect(result.content).toContain('Checkpoint saved');
    expect(result.content).toContain('Inspect its output and saved files before repeating it');
  });
  it('bounds timeout output while retaining the final diagnostic', async () => {
    const result = await tool().execute({ command: 'printf "%070000d\\n" 0; printf "LAST_DIAGNOSTIC\\n" >&2; sleep 30', timeout: 300 }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(50_000);
    expect(result.content).toContain('timed out after 300ms');
    expect(result.content).toContain('omitted');
    expect(result.content).toContain('LAST_DIAGNOSTIC');
  });
  it('stops its native descendants while another session finishes its command', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'shell-stop-'));
    const controller = new AbortController();
    const closing = { ...makeCtx(), cwd, abortSignal: controller.signal };
    const neighbour = { ...makeCtx(), cwd };
    const script = join(cwd, 'task.cjs');
    await writeFile(script, `
      const fs = require('node:fs');
      const role = process.argv[2];
      if (role === 'parent') require('node:child_process').spawn(process.execPath, [__filename, 'child'], { stdio: 'ignore' });
      fs.writeFileSync(role + '.ready', String(process.pid));
      const timer = setInterval(() => {
        if (fs.existsSync(role + '.go') || fs.existsSync('finish')) {
          clearInterval(timer);
          fs.writeFileSync(role + '.done', 'done');
        }
      }, 10);
      setTimeout(() => process.exit(0), 15000).unref();
    `);
    const quote = (path: string) => `'${path.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
    const command = (role: string) => `${quote(process.execPath)} ${quote(script)} ${role}`;
    const first = tool().execute({ command: command('parent') }, closing);
    const second = tool().execute({ command: command('neighbour') }, neighbour);
    try {
      await vi.waitFor(() => Promise.all(['parent', 'child', 'neighbour'].map(role => access(join(cwd, `${role}.ready`)))), { timeout: 5000 });
      const pids = await Promise.all(['parent', 'child'].map(async role => Number(await readFile(join(cwd, `${role}.ready`), 'utf8'))));
      expect(pids.every(pid => Number.isInteger(pid) && pid > 0)).toBe(true);
      controller.abort();
      const stopped = await first;
      expect(stopped.isError).toBe(true);
      if (process.platform !== 'win32') expect(stopped.content).not.toContain('could be confirmed stopped');
      // A killed process can stay a zombie until its new parent reaps it; only a running one would fail here.
      await vi.waitFor(() => {
        for (const pid of pids) expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
      }, { timeout: 2000 });
      await writeFile(join(cwd, 'neighbour.go'), 'go');
      expect((await second).isError).toBe(false);
      expect(await readFile(join(cwd, 'neighbour.done'), 'utf8')).toBe('done');
    } finally {
      await writeFile(join(cwd, 'finish'), 'done');
      await Promise.allSettled([first, second]);
      await rm(cwd, { recursive: true, force: true });
    }
  }, 20000);

  it('terminates a command that exceeds the timeout', async () => {
    const result = await tool().execute({ command: 'sleep 30', timeout: 300 }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('timed out');
  }, 10_000);
});
