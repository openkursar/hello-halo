import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
    const [text, notice] = result.content.split('\n');
    expect(text).toBe('����');
    expect(result.content).toContain('\nSome output was not valid UTF-8');
    const path = /The exact captured bytes of stdout and stderr, combined, are in (.+)\.$/.exec(notice)?.[1];
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
  it('terminates a command that exceeds the timeout', async () => {
    const result = await tool().execute({ command: 'sleep 30', timeout: 300 }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('timed out');
  }, 10_000);
});
