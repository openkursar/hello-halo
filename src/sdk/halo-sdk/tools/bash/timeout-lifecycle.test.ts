import { afterEach, describe, expect, it } from 'vitest';
import { getEventListeners } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, type SDKSession } from '../../core/session.js';
import { query } from '../../index.js';
import type { LlmProvider, StreamEvent } from '../../types/provider.js';
import type { Options } from '../../types/config.js';
import { BackgroundTaskRegistry, type BackgroundTask } from './background.js';
import { BashTool } from './index.js';

const sessions: SDKSession[] = [];
const directories: string[] = [];
const registries: BackgroundTaskRegistry[] = [];

afterEach(async () => {
  for (const session of sessions) session.close();
  for (const registry of registries) registry.dispose();
  await Promise.all(sessions.splice(0).map(session => session.flush()));
  await Promise.all(registries.splice(0).map(registry => registry.flush()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixtureOptions() {
  const directory = await mkdtemp(join(tmpdir(), 'sdk-background-lifecycle-'));
  directories.push(directory);
  const controller = new AbortController();
  const tasks: BackgroundTask[] = [];
  let requests = 0;
  const provider: LlmProvider = {
    id: 'fixture', name: 'fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false,
      pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { throw new Error('Unexpected summary request'); },
    async *createMessageStream(): AsyncGenerator<StreamEvent> {
      const launch = requests++ % 2 === 0;
      yield { type: 'message_start', id: `response-${requests}`, model: 'fixture', usage: { input_tokens: 10, output_tokens: 5 } };
      yield { type: 'content_block_start', index: 0, content_block: launch
        ? { type: 'tool_use', id: `call-${requests}`, name: 'Bash', input: { command: 'sleep 30', run_in_background: true } }
        : { type: 'text', text: 'Started.' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: launch ? 'tool_use' : 'end_turn' };
      yield { type: 'message_stop' };
    },
  };
  const options: Options = {
    provider, model: 'fixture', cwd: directory, systemPrompt: 'Fixture', settingSources: [],
    abortController: controller, tools: [], persistSession: false,
    permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
    turnEndChecks: { openWork: false, completion: false },
    env: { SDK_STATE: join(directory, 'state'), HOME: directory }, conventions: { configDirEnv: 'SDK_STATE' },
    customTools: [{ ...BashTool, async execute(input, ctx) {
      const result = await BashTool.execute(input, ctx);
      const task = ctx.services?.backgroundTasks?.get(result.metadata?.task_id as string);
      if (task) tasks.push(task);
      return result;
    } }],
  };
  return { options, controller, tasks };
}

async function sessionFixture() {
  const { options, controller, tasks } = await fixtureOptions();
  const session = await createSession(options);
  sessions.push(session);
  const run = async () => {
    await session.send('Start background work.');
    for await (const message of session.stream()) if (message.type === 'result') break;
  };
  return { session, controller, tasks, run };
}

describe('background cancellation ownership', () => {
  it('keeps an accepted task session-owned when its invoking signal is cancelled', async () => {
    const registry = new BackgroundTaskRegistry();
    registries.push(registry);
    const controller = new AbortController();
    const task = await registry.start({ command: 'sleep 30',
      state: { cwd: tmpdir(), envVars: new Map() }, env: {}, abortSignal: controller.signal });
    controller.abort();
    expect(task.status).toBe('running');
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    registry.dispose();
    await task.done;
    expect(task.status).toBe('stopped');
  });

  it('keeps work across normal turns but stops it when the supplied session controller aborts', async () => {
    const { session, controller, tasks, run } = await sessionFixture();
    await run();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe('running');
    controller.abort();
    expect(tasks[0].status).toBe('stopped');
    await tasks[0].done;
    session.close();
    await session.flush();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('rebinds session cancellation after interrupt without stopping later normal work', async () => {
    const { session, controller, tasks, run } = await sessionFixture();
    await run();
    await session.interrupt();
    await tasks[0].done;
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    await run();
    expect(tasks).toHaveLength(2);
    expect(tasks[1].status).toBe('running');
    await session.interrupt();
    await tasks[1].done;
    expect(tasks[1].status).toBe('stopped');
  });

  it('cancels one-shot background work while the result is awaiting consumer acknowledgement', async () => {
    const { options, controller, tasks } = await fixtureOptions();
    const current = query({ prompt: 'Start background work.', options });
    try {
      while (true) {
        const next = await current.next();
        expect(next.done).not.toBe(true);
        if (next.value?.type === 'result') break;
      }
      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe('running');
      controller.abort();
      expect(tasks[0].status).toBe('stopped');
      await tasks[0].done;
    } finally {
      await current.return(undefined);
    }
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});
