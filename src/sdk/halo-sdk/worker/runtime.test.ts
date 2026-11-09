import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createWorkerRuntime, createSdkMcpServer, tool, RESUME_HISTORY_UNAVAILABLE, isResumeHistoryError } from './index.js';
import { buildWorker } from '../scripts/build-worker.mjs';
import type { WorkerRuntime, WorkerSession } from './index.js';
import type { Options } from '../types/config.js';

const setup = { module: new URL('./fixtures/setup.mjs', import.meta.url).href };
let directory: string;
let buildDirectory: string;
beforeAll(async () => {
  buildDirectory = await mkdtemp(join(tmpdir(), 'sdk-worker-build-'));
  await buildWorker(join(buildDirectory, 'entry.mjs'));
});
afterAll(async () => { await rm(buildDirectory, { recursive: true, force: true }); });
const runtimes: WorkerRuntime[] = [];
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'sdk-worker-')); });
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await rm(directory, { recursive: true, force: true });
});
function runtime(options = {}) {
  const result = createWorkerRuntime({ workerUrl: pathToFileURL(join(buildDirectory, 'entry.mjs')), maxWorkers: 2, startupTimeoutMs: 5000, closeTimeoutMs: 5000, ...options });
  runtimes.push(result);
  return result;
}
function options(overrides: Partial<Options> = {}): Options {
  return { model: 'test-model', apiKey: 'fixture', cwd: directory, env: { CLAUDE_CONFIG_DIR: directory },
    systemPrompt: 'Test assistant', persistSession: false, tools: [], settingSources: [], turnEndChecks: { openWork: false, completion: false }, ...overrides };
}
async function session(pool: WorkerRuntime, data = {}, overrides: Partial<Options> = {}, group?: string) {
  return pool.createSession(options(overrides), { group, setup: { ...setup, data } });
}
async function turn(session: WorkerSession, text = 'hello') {
  await session.send(text);
  const events = [];
  for await (const event of session.stream()) { events.push(event); if (event.type === 'result') break; }
  return events;
}
function result(events: any[]) { return events.find(event => event.type === 'result'); }
async function eventually(check: () => boolean | Promise<boolean>, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!await check()) { if (Date.now() > end) throw new Error('Condition timed out'); await delay(10); }
}

describe('grouped worker runtime with real threads', () => {
  it('reports a refused strict resume to the host with its code and reason', async () => {
    const pool = runtime();
    const creation = session(pool, {}, { resume: '00000000-0000-4000-8000-000000000000', strictResume: true });
    await expect(creation).rejects.toMatchObject({ name: 'ResumeHistoryError', code: RESUME_HISTORY_UNAVAILABLE, reason: 'missing' });
    expect(isResumeHistoryError(await creation.catch(error => error))).toBe(true);
  });

  it('settles initialization when shutdown races a cold worker start', async () => {
    const pool = runtime();
    const warming = pool.initialize();
    const stopped = pool.close();
    await expect(warming).rejects.toThrow('closed');
    await stopped;
    expect(pool.diagnostics()).toMatchObject({ closed: true, workers: [] });
  });

  it('retains host async context for callbacks and detaches deliberate-close observers safely', async () => {
    const context = new AsyncLocalStorage<string>();
    const hook = vi.fn(async () => { expect(context.getStore()).toBe('owner'); return {}; });
    const current = await context.run('owner', () => session(runtime(), {}, { hooks: { UserPromptSubmit: [{ hooks: [hook] }] } }));
    await turn(current);
    expect(hook).toHaveBeenCalledOnce();
    const exited = vi.fn();
    const detach = current.query.transport.onExit(exited);
    current.abortController.abort();
    detach();
    await current.flush();
    expect(exited).not.toHaveBeenCalled();
  });

  it('constructs standard providers from configuration without a setup module', async () => {
    const current = await runtime().createSession({ ...options(), apiKey: undefined,
      providerConfig: { type: 'openai-compat', apiKey: 'fixture', baseUrl: 'http://127.0.0.1:1' },
    });
    expect(result(await turn(current, '/help')).is_error).toBe(false);
  });

  it('keeps provider credentials and request identity separate across sessions on one worker', async () => {
    const received: Array<{ key: string; model: string; prefix: string }> = [];
    const server = createServer((request, response) => {
      let raw = '';
      request.on('data', data => { raw += data; });
      request.on('end', () => {
        const body = JSON.parse(raw);
        received.push({ key: String(request.headers['x-api-key']), model: body.model, prefix: body.system[0].text });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const events = [
          { type: 'message_start', message: { id: 'request', role: 'assistant', type: 'message', model: body.model, content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'response' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
          { type: 'message_stop' },
        ];
        response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const pool = runtime();
      const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const create = (name: string) => pool.createSession(options({ model: name, apiKey: name, anthropicBaseUrl: baseUrl,
        requestIdentity: { systemPrefix: async (_messages, context) => {
          expect(context?.signal).toBeInstanceOf(AbortSignal);
          return { type: 'text' as const, text: name };
        } },
      }));
      const [a, b] = await Promise.all([create('account-a'), create('account-b')]);
      expect(a.threadId).toBe(b.threadId);
      await Promise.all([turn(a), turn(b)]);
      expect(received.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
        { key: 'account-a', model: 'account-a', prefix: 'account-a' }, { key: 'account-b', model: 'account-b', prefix: 'account-b' },
      ]);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('does not spawn on construction; concurrent prewarm and creation share startup', async () => {
    const pool = runtime();
    expect(pool.diagnostics().workers).toHaveLength(0);
    const [a, b] = await Promise.all([session(pool, {}, {}, 'a'), session(pool, {}, {}, 'a'), pool.initialize()]);
    expect(a.threadId).toBe(b.threadId);
    expect(pool.diagnostics().workers).toHaveLength(1);
    const answer = JSON.parse(result(await turn(a)).result);
    expect(answer.threadId).toBe(a.threadId);
    expect(answer.threadId).toBeGreaterThan(0);
  });

  it('bounds workers while admitting many groups, and reclaims empty excess workers', async () => {
    const pool = runtime({ targetActiveSessions: 1, idleTimeoutMs: 25, heartbeatIntervalMs: 25 });
    const sessions = await Promise.all(Array.from({ length: 12 }, (_, index) => session(pool, {}, {}, String(index))));
    expect(new Set(sessions.map(item => item.threadId)).size).toBe(2);
    expect(pool.diagnostics().workers).toHaveLength(2);
    await Promise.all(sessions.map(item => item[Symbol.asyncDispose]()));
    await eventually(() => pool.diagnostics().workers.length === 1);
  });

  it.each([undefined, Infinity])('expands beyond four workers without a host ceiling (%s)', async maxWorkers => {
    const pool = runtime({ maxWorkers, targetActiveSessions: 1, startupTimeoutMs: 30_000,
      idleTimeoutMs: 25, heartbeatIntervalMs: 25 });
    await pool.initialize();
    expect(pool.diagnostics().workers).toHaveLength(1);
    const sessions = await Promise.all(Array.from({ length: 6 }, () => session(pool)));
    expect(new Set(sessions.map(current => current.threadId)).size).toBe(6);
    const events = await Promise.all(sessions.map(current => turn(current)));
    expect(events.every(messages => !result(messages).is_error)).toBe(true);
    await Promise.all(sessions.map(current => current[Symbol.asyncDispose]()));
    await eventually(() => pool.diagnostics().workers.length === 1);
  });

  it('validates finite host budgets and refuses unbounded eager prewarming', () => {
    for (const maxWorkers of [0, -1, 1.5, NaN, -Infinity]) {
      expect(() => createWorkerRuntime({ maxWorkers })).toThrow('Invalid maxWorkers');
    }
    expect(() => createWorkerRuntime({ warmWorkers: Infinity })).toThrow('Invalid warmWorkers');
    expect(() => createWorkerRuntime({ warmWorkers: 3, maxWorkers: 2 })).toThrow('warmWorkers cannot exceed maxWorkers');
  });

  it('can disable prewarming and disposes its last empty worker', async () => {
    const pool = runtime({ warmWorkers: 0, idleTimeoutMs: 25, heartbeatIntervalMs: 25 });
    await pool.initialize();
    expect(pool.diagnostics().workers).toHaveLength(0);
    const current = await session(pool);
    await current[Symbol.asyncDispose]();
    await eventually(() => pool.diagnostics().workers.length === 0);
  });

  it('keeps accounts, histories, models and goals isolated in a shared worker', async () => {
    const pool = runtime();
    const [a, b] = await Promise.all([session(pool), session(pool)]);
    expect(a.threadId).toBe(b.threadId);
    await a.setModel('different');
    await a.setGoal({ objective: 'Only A' });
    await expect(a.setGoal({ objective: '   ' })).rejects.toBeInstanceOf(TypeError);
    expect(await b.getGoal()).toBeNull();
    const answerA = JSON.parse(result(await turn(a, 'private A')).result);
    const answerB = JSON.parse(result(await turn(b, 'private B')).result);
    expect(answerA.model).toBe('different');
    expect(answerB.model).toBe('test-model');
    expect(JSON.stringify(answerB.messages)).not.toContain('private A');
  });

  it('runs a collaborator in its source worker without another thread', async () => {
    const pool = runtime();
    const current = await session(pool, { tools: [{ name: 'mcp__halo-team__spawn_agent', input: { prompt: 'Inspect the fixture' } }] },
      { tools: ['spawn_agent'], permissionMode: 'bypassPermissions' });
    const events = await turn(current);
    expect(result(events).is_error).toBe(false);
    expect(JSON.parse(result(events).result).calls).toBeGreaterThanOrEqual(3);
    expect(pool.diagnostics().workers).toHaveLength(1);
  });

  it('removes interrupted collaborators from worker placement load', async () => {
    const pool = runtime({ heartbeatIntervalMs: 25 });
    const current = await session(pool, { collaboratorDelayMs: 5000, tools: [{ name: 'mcp__halo-team__spawn_agent', input: { prompt: 'Inspect' } }] },
      { tools: ['spawn_agent'], permissionMode: 'bypassPermissions' });
    const running = turn(current);
    await eventually(() => pool.diagnostics().workers[0].collaborators === 1);
    await current.interrupt();
    await running;
    await eventually(() => pool.diagnostics().workers[0].collaborators === 0);
  });

  it('accepts live inputs synchronously, withdraws unread inputs once, and preserves ordinary sends', async () => {
    const current = await session(runtime());
    const withdrawn = vi.fn();
    await current.send('ordinary');
    expect(current.sendIntoLiveTurn('withdraw me', { onWithdrawn: withdrawn })).toBe(true);
    expect(current.hasPendingInput()).toBe(true);
    expect(await current.withdrawUnreadInput()).toBe(1);
    expect(withdrawn).toHaveBeenCalledTimes(1);
    expect(await current.withdrawUnreadInput()).toBe(0);
    expect(current.hasPendingInput()).toBe(true);
    const events = [];
    for await (const event of current.stream()) events.push(event);
    expect(result(events).result).toContain('ordinary');
    expect(result(events).result).not.toContain('withdraw me');
    expect(current.hasPendingInput()).toBe(false);
  });

  it('refuses an uncloneable live input without claiming it or retiring the session', async () => {
    const current = await session(runtime());
    expect(current.sendIntoLiveTurn({ content: 'invalid', callback: () => {} })).toBe(false);
    expect(current.hasPendingInput()).toBe(false);
    expect(result(await turn(current, 'valid')).is_error).toBe(false);
  });

  it('delivers additions during model work and across the final-result boundary', async () => {
    const startedFile = join(directory, 'started');
    const current = await session(runtime(), { delayMs: 75, startedFile });
    const first = turn(current, 'first');
    await eventually(() => access(startedFile).then(() => true, () => false));
    expect(current.sendIntoLiveTurn('while working')).toBe(true);
    const events = await first;
    expect(result(events).result).toContain('while working');
    expect(current.sendIntoLiveTurn('after result')).toBe(true);
    const next = [];
    for await (const event of current.stream()) next.push(event);
    expect(result(next).result).toContain('after result');
    expect(current.hasPendingInput()).toBe(false);
  });

  it('bridges host MCP tools, hooks and permission decisions without losing their schemas', async () => {
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'host result' }] }));
    const permission = vi.fn(async (_name, _input, context) => {
      expect(context.signal).toBeInstanceOf(AbortSignal);
      return { behavior: 'allow' as const };
    });
    const hook = vi.fn(async (_input, _id, context) => {
      expect(context.signal).toBeInstanceOf(AbortSignal);
      return {};
    });
    const current = await session(runtime(), { tools: [{ name: 'mcp__host__action' }] }, {
      mcpServers: { host: createSdkMcpServer({ name: 'host', tools: [tool('action', 'Action', {}, handler)] }) },
      canUseTool: permission, permissionMode: 'default', hooks: { PreToolUse: [{ hooks: [hook] }] },
    });
    expect(result(await turn(current)).is_error).toBe(false);
    expect(handler).toHaveBeenCalledOnce();
    expect(permission).toHaveBeenCalledOnce();
    expect(hook).toHaveBeenCalledOnce();
  });

  it('interrupts one session and cancels its approval without terminating a shared worker', async () => {
    let approvalSignal: AbortSignal | undefined;
    const pool = runtime();
    const a = await session(pool, { tools: [{ name: 'mcp__host__action' }] }, {
      mcpServers: { host: createSdkMcpServer({ name: 'host', tools: [tool('action', 'Action', {}, async () => ({ content: [] }))] }) },
      permissionMode: 'default', canUseTool: async (_name, _input, context) => {
        approvalSignal = context.signal;
        return new Promise(() => {});
      },
    });
    const b = await session(pool);
    const events = turn(a);
    await eventually(() => !!approvalSignal);
    await a.interrupt();
    await events;
    expect(approvalSignal!.aborted).toBe(true);
    expect(result(await turn(b)).is_error).toBe(false);
    expect(pool.diagnostics().workers[0].threadId).toBe(a.threadId);
  });

  it('can close a session whose custom model stream ignores cancellation', async () => {
    const pool = runtime({ maxWorkers: 1, closeTimeoutMs: 1000 });
    const startedFile = join(directory, 'model-started');
    const current = await session(pool, { startedFile, stalledModel: true });
    const neighbour = await session(pool);
    const running = turn(current);
    await eventually(() => access(startedFile).then(() => true, () => false));
    await current[Symbol.asyncDispose]();
    await running;
    expect(result(await turn(neighbour)).is_error).toBe(false);
    expect(pool.diagnostics().recentFailures).toBe(0);
  });

  it('closes pending startup hooks and still completes SessionEnd hooks', async () => {
    let startupSignal: AbortSignal | undefined;
    const ended = vi.fn(async () => { await delay(20); return {}; });
    const current = await session(runtime(), {}, { hooks: {
      SessionStart: [{ hooks: [async (_input, _id, context) => { startupSignal = context.signal; return new Promise(() => {}); }] }],
      SessionEnd: [{ hooks: [ended] }],
    } });
    await eventually(() => !!startupSignal);
    await current[Symbol.asyncDispose]();
    expect(startupSignal!.aborted).toBe(true);
    expect(ended).toHaveBeenCalledOnce();
  });

  it.each(['host', 'worker'])('cancels a stalled %s end hook without killing a shared worker', async location => {
    const pool = runtime({ maxWorkers: 1, closeTimeoutMs: 1000 });
    let endSignal: AbortSignal | undefined;
    const current = await session(pool, { stalledEndHook: location === 'worker' }, location === 'host' ? {
      hooks: { SessionEnd: [{ hooks: [async (_input, _id, { signal }) => { endSignal = signal; return new Promise(() => {}); }] }] },
    } : {});
    const neighbour = await session(pool);
    await current[Symbol.asyncDispose]();
    if (location === 'host') expect(endSignal?.aborted).toBe(true);
    expect(result(await turn(neighbour)).is_error).toBe(false);
    expect(pool.diagnostics()).toMatchObject({ recentFailures: 0, workers: [{ threadId: neighbour.threadId, sessions: 1 }] });
  });

  it.each(['host', 'worker'])('disposes a collaborator awaiting a %s end hook without killing its worker', async location => {
    const pool = runtime({ maxWorkers: 1, closeTimeoutMs: 1000 });
    let hookSignal: AbortSignal | undefined;
    const collaboratorEndStartedFile = join(directory, 'collaborator-end');
    const current = await session(pool, { stalledCollaboratorEnd: location === 'worker', collaboratorEndStartedFile,
      tools: [{ name: 'mcp__halo-team__spawn_agent', input: { prompt: 'Inspect the fixture' } }] }, {
      sessionId: 'source-session', tools: ['spawn_agent'], permissionMode: 'bypassPermissions', collaboration: { mode: 'local', maxIdleSessions: 0 },
      ...(location === 'host' ? { hooks: { SessionEnd: [{ hooks: [async (input, _id, { signal }) => {
        if (input.session_id === 'source-session') return {};
        hookSignal = signal;
        return new Promise(() => {});
      }] }] } } : {}),
    });
    const neighbour = await session(pool);
    const running = turn(current);
    await eventually(() => location === 'host' ? !!hookSignal : access(collaboratorEndStartedFile).then(() => true, () => false));
    await current[Symbol.asyncDispose]();
    await running;
    if (location === 'host') expect(hookSignal!.aborted).toBe(true);
    expect(result(await turn(neighbour)).is_error).toBe(false);
    expect(pool.diagnostics().recentFailures).toBe(0);
  });

  it('honours explicit cancellation of end hooks while still draining session disposal', async () => {
    const pool = runtime();
    const hook = vi.fn(async () => ({}));
    const current = await session(pool, {}, { hooks: { SessionEnd: [{ hooks: [hook] }] } });
    const controller = new AbortController();
    controller.abort();
    current.close({ signal: controller.signal });
    await current.flush();
    expect(hook).not.toHaveBeenCalled();
    expect(pool.diagnostics().workers[0].sessions).toBe(0);
  });

  it('does not apply a short application shutdown budget to ordinary session retirement', async () => {
    const pool = runtime({ closeTimeoutMs: 5000, shutdownTimeoutMs: 500 });
    let finished = false;
    const current = await session(pool, {}, { hooks: { SessionEnd: [{ hooks: [async () => {
      await delay(750); finished = true; return {};
    }] }] } });
    await current[Symbol.asyncDispose]();
    expect(finished).toBe(true);
    expect(pool.diagnostics().recentFailures).toBe(0);
  });

  it('shortens already running end hooks when the whole runtime shuts down', async () => {
    const pool = runtime({ closeTimeoutMs: 5000, shutdownTimeoutMs: 1000 });
    let signal: AbortSignal | undefined;
    const current = await session(pool, {}, { hooks: { SessionEnd: [{ hooks: [async (_input, _id, context) => {
      signal = context.signal; return new Promise(() => {});
    }] }] } });
    current.close();
    await eventually(() => !!signal);
    await pool.close();
    expect(signal!.aborted).toBe(true);
    expect(pool.diagnostics()).toMatchObject({ closed: true, workers: [], recentFailures: 0 });
  });

  it('waits for retirement and persistence before a different worker resumes the transcript', async () => {
    const pool = runtime({ targetActiveSessions: 1 });
    const a = await session(pool, {}, { persistSession: true });
    await turn(a, 'remember me');
    a.close();
    const b = await session(pool, {}, { persistSession: true, resume: a.sessionId });
    expect(result(await turn(b, 'next')).result).toContain('remember me');
    await expect(session(pool, {}, { resume: b.sessionId })).rejects.toThrow('already owned');
  });

  it('waits for session state retirement even when its storage configuration changes', async () => {
    const pool = runtime();
    const a = await session(pool, {}, { hooks: { SessionEnd: [{ hooks: [async () => { await delay(50); return {}; }] }] } });
    a.close();
    const b = await session(pool, {}, { sessionId: a.sessionId, env: { CLAUDE_CONFIG_DIR: join(directory, 'other') }, goal: { objective: 'New settings' } });
    await a.flush();
    expect(await b.getGoal()).toMatchObject({ objective: 'New settings' });
  });

  it('streams many tiny deltas with bounded transport and no final message loss', async () => {
    const current = await session(runtime(), { deltas: 2000 }, { includePartialMessages: true });
    const events = await turn(current);
    expect(result(events).result).toHaveLength(2000);
    const deltas = events.filter((event: any) => event.type === 'stream_event' && event.event.type === 'content_block_delta');
    expect(deltas).toHaveLength(2000);
  });

  it('keeps the parent responsive during a worker deadlock and retires every affected session', async () => {
    const pool = runtime({ maxWorkers: 1, heartbeatIntervalMs: 25, heartbeatTimeoutMs: 250 });
    const stuck = await session(pool, { hang: true });
    const neighbour = await session(pool);
    const exit = vi.fn();
    neighbour.query.transport.onExit(exit);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    try { await expect(turn(stuck)).rejects.toThrow('heartbeat'); }
    finally { clearInterval(timer); }
    expect(ticks).toBeGreaterThan(3);
    expect(exit).toHaveBeenCalledOnce();
    expect(neighbour.query.transport.ready).toBe(false);
    await eventually(() => pool.diagnostics().workers.length === 0);
    const replacement = await session(pool);
    expect(result(await turn(replacement)).is_error).toBe(false);
  });

  it('rejects pending operations on unexpected worker exit and replaces only on demand', async () => {
    const pool = runtime();
    const current = await session(pool, { crash: true });
    await expect(turn(current)).rejects.toThrow('exited');
    await eventually(() => pool.diagnostics().workers.length === 0);
    expect(pool.diagnostics().recentFailures).toBe(1);
    expect(result(await turn(await session(pool))).is_error).toBe(false);
  });

  it('coordinates file mutations when the same directory spans workers', async () => {
    const pool = runtime({ targetActiveSessions: 1 });
    const target = join(directory, 'shared.txt');
    await writeFile(target, 'before');
    const data = { tools: [{ name: 'Read', input: { file_path: target } }, { name: 'Write', input: { file_path: target, content: 'after' } }] };
    const sessions = await Promise.all([session(pool, data, { tools: ['Read', 'Write'], permissionMode: 'bypassPermissions' }),
      session(pool, data, { tools: ['Read', 'Write'], permissionMode: 'bypassPermissions' })]);
    expect(sessions[0].threadId).not.toBe(sessions[1].threadId);
    await Promise.all(sessions.map(current => turn(current)));
    expect(await readFile(target, 'utf8')).toBe('after');
    expect(pool.diagnostics().fileLocks).toBe(0);
  });

  it('executes one-shot queries on the worker and releases their resources', async () => {
    const pool = runtime();
    const events = [];
    for await (const event of pool.query({ prompt: 'query', options: options() }, { setup })) events.push(event);
    expect(JSON.parse(result(events).result).threadId).toBeGreaterThan(0);
    expect(pool.diagnostics().workers[0].sessions).toBe(0);
  });

  it('aborts a creation in progress without leaking a late session or its callbacks', async () => {
    const pool = runtime();
    await pool.initialize();
    const controller = new AbortController();
    const creation = session(pool, { prepareDelayMs: 100 }, { abortController: controller });
    await delay(20);
    controller.abort();
    await expect(creation).rejects.toThrow(/abort/i);
    expect(pool.diagnostics().workers[0].sessions).toBe(0);
    expect(result(await turn(await session(pool))).is_error).toBe(false);
  });

  it('cancels MCP preparation without terminating another session in the same worker', async () => {
    let arrived!: () => void;
    const requested = new Promise<void>(resolve => { arrived = resolve; });
    const server = createServer((_request, _response) => arrived());
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const pool = runtime({ maxWorkers: 1, closeTimeoutMs: 1000 });
      const neighbour = await session(pool);
      const controller = new AbortController();
      const creating = session(pool, {}, { abortController: controller, mcpServers: {
        stalled: { type: 'http', url: `http://127.0.0.1:${(server.address() as { port: number }).port}` },
      } });
      const rejected = expect(creating).rejects.toThrow(/abort|cancel/i);
      await requested;
      controller.abort();
      await rejected;
      expect(result(await turn(neighbour)).is_error).toBe(false);
      expect(pool.diagnostics()).toMatchObject({ recentFailures: 0, workers: [{ threadId: neighbour.threadId, sessions: 1 }] });
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('cancels a stalled custom preparation without taking down a shared worker', async () => {
    const pool = runtime({ maxWorkers: 1, closeTimeoutMs: 1000 });
    const neighbour = await session(pool);
    const controller = new AbortController();
    const preparingFile = join(directory, 'custom-preparation');
    const creating = session(pool, { preparingFile, stalledPreparation: true }, { abortController: controller });
    const rejected = expect(creating).rejects.toThrow(/abort/i);
    await eventually(() => access(preparingFile).then(() => true, () => false));
    controller.abort();
    await rejected;
    expect(result(await turn(neighbour)).is_error).toBe(false);
    expect(pool.diagnostics()).toMatchObject({ recentFailures: 0, workers: [{ threadId: neighbour.threadId, sessions: 1 }] });
  });

  it('retires an in-flight MCP reconfiguration without reviving it or stopping a neighbour', async () => {
    let arrived!: () => void;
    const requested = new Promise<void>(resolve => { arrived = resolve; });
    const server = createServer((_request, _response) => arrived());
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const pool = runtime({ maxWorkers: 1, closeTimeoutMs: 1000 });
      const [current, neighbour] = await Promise.all([session(pool), session(pool)]);
      const pending = current.query.setMcpServers({ stalled: {
        type: 'http', url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      } });
      const rejected = expect(pending).rejects.toThrow(/abort|closed/i);
      await requested;
      await current[Symbol.asyncDispose]();
      await rejected;
      expect(result(await turn(neighbour)).is_error).toBe(false);
      expect(pool.diagnostics()).toMatchObject({ recentFailures: 0, workers: [{ threadId: neighbour.threadId, sessions: 1 }] });
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('gives session preparation a separate deadline from worker startup', async () => {
    const pool = runtime({ startupTimeoutMs: 5000, sessionStartupTimeoutMs: 1000 });
    await pool.initialize();
    await expect(session(pool, { prepareDelayMs: 1500 })).rejects.toThrow('timed out');
    expect(pool.diagnostics().recentFailures).toBe(0);
  });

  it('stops retrying after repeated fatal worker failures', async () => {
    const pool = runtime({ maxWorkers: 1 });
    for (let i = 0; i < 3; i++) {
      const current = await session(pool, { reject: true });
      await expect(turn(current)).rejects.toThrow('exited');
    }
    await expect(session(pool)).rejects.toThrow('circuit');
  });

  it('can use file tools again after interrupt resets the turn cancellation signal', async () => {
    const target = join(directory, 'after-interrupt.txt');
    await writeFile(target, 'file content');
    const current = await session(runtime(), { tools: [{ name: 'Read', input: { file_path: target } }] }, {
      tools: ['Read'], permissionMode: 'bypassPermissions',
    });
    await current.interrupt();
    expect(result(await turn(current)).result).toContain('file content');
  });

  it('releases a background child when its session closes', async () => {
    const pool = runtime();
    const pidFile = join(directory, 'child-pid');
    const scriptFile = join(directory, 'background-child.cjs');
    const script = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(()=>{},1000)`;
    await writeFile(scriptFile, script);
    const command = `"${process.execPath.replaceAll('\\', '/')}" "${scriptFile.replaceAll('\\', '/')}"`;
    const current = await session(pool, { tools: [{ name: 'Bash', input: { command, run_in_background: true } }] }, {
      tools: ['Bash'], permissionMode: 'bypassPermissions',
    });
    await turn(current);
    await eventually(() => access(pidFile).then(() => true, () => false));
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(pool.diagnostics().workers[0].children).toBeGreaterThan(0);
    await current[Symbol.asyncDispose]();
    await eventually(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    expect(pool.diagnostics().workers[0].children).toBe(0);
  });

  it('closes shells still starting POSIX children without retiring their shared worker', async () => {
    const pool = runtime({ maxWorkers: 1, closeTimeoutMs: 10_000 });
    const neighbour = await session(pool);
    const closing = await Promise.all(Array.from({ length: 2 }, () => session(pool, { tools: [{ name: 'Bash', input: { command: 'sleep 30', run_in_background: true } }] }, {
      tools: ['Bash'], permissionMode: 'bypassPermissions',
    })));
    await Promise.all(closing.map(current => turn(current)));
    await Promise.all(closing.map(current => current[Symbol.asyncDispose]()));
    expect(pool.diagnostics()).toMatchObject({ recentFailures: 0, workers: [{ sessions: 1, children: 0 }] });
    expect(result(await turn(neighbour)).is_error).toBe(false);
  }, 15_000);

  it.each([false, true])('terminates MCP descendants after session close or worker failure (crash=%s)', async crash => {
    const pool = runtime();
    const pidFile = join(directory, 'mcp-pids.json');
    const current = await session(pool, { crash }, { mcpServers: { fixture: {
      command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp.cjs', import.meta.url)), pidFile],
    } } });
    const pids = JSON.parse(await readFile(pidFile, 'utf8')) as number[];
    if (crash) await expect(turn(current)).rejects.toThrow('exited');
    else await current[Symbol.asyncDispose]();
    await eventually(() => pids.every(pid => {
      try { process.kill(pid, 0); } catch { return true; }
      if (process.platform === 'win32') return false;
      // Node can leave a dead child's wait status behind when its owning thread exits.
      try { return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z'); }
      catch { return true; }
    }));
  });
});
