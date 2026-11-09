import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSdkCollaboration, type SdkCollaborationBinding } from './index.js';
import type { Options } from '../../types/config.js';
import type { LlmProvider, ProviderRequest, StreamEvent, ToolResultBlock } from '../../types/provider.js';
import { toolSuccess, type Tool } from '../../types/tool.js';

let directory: string;
const bindings: SdkCollaborationBinding[] = [];
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'sdk-collaboration-retention-')));
  await mkdir(join(directory, 'nested'));
  await writeFile(join(directory, 'facts.txt'), 'Original evidence.');
});
afterEach(async () => {
  await Promise.all(bindings.splice(0).map(binding => binding.close()));
  await rm(directory, { recursive: true, force: true });
});

function provider(respond: (request: ProviderRequest) => Promise<Array<{ name: string; input: Record<string, unknown> }>> | Array<{ name: string; input: Record<string, unknown> }>): LlmProvider {
  let sequence = 0;
  return {
    id: 'retention-fixture', name: 'Retention fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false,
      pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { throw new Error('Unexpected summary'); },
    async *createMessageStream(request): AsyncGenerator<StreamEvent> {
      const calls = await respond(request);
      const id = ++sequence;
      const usage = { input_tokens: 10, output_tokens: 10 };
      yield { type: 'message_start', id: `message-${id}`, model: request.model, usage };
      for (const [index, call] of calls.entries()) {
        yield { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `call-${id}-${index}`, ...call } };
        yield { type: 'content_block_stop', index };
      }
      if (!calls.length) {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'The assigned step has ended.' } };
        yield { type: 'content_block_stop', index: 0 };
      }
      yield { type: 'message_delta', stopReason: calls.length ? 'tool_use' : 'end_turn', usage };
      yield { type: 'message_stop' };
    },
  };
}

function setup(llm: LlmProvider, overrides: Partial<Options> = {}, maxIdleSessions = 0) {
  const base: Options = {
    provider: llm, model: 'fixture', cwd: directory, settingSources: [], persistSession: false,
    env: { HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'config') },
    permissionMode: 'bypassPermissions', turnEndChecks: { openWork: false, completion: false }, ...overrides,
  };
  const notices: string[] = [];
  const binding = createSdkCollaboration({ sessionId: randomUUID(), getOptions: () => base,
    settings: { maxIdleSessions }, deliverToSource: async envelope => { notices.push(envelope.body); return 'buffered'; } });
  bindings.push(binding);
  return { binding, base, notices };
}

async function settled(binding: SdkCollaborationBinding): Promise<void> {
  while (binding.activeCount > 0) await binding.waitForChange(binding.revision);
}

async function call(binding: SdkCollaborationBinding, name: string, input: Record<string, unknown>) {
  const result = await binding.server.instance.callTool(name, input);
  expect(result?.isError, JSON.stringify(result)).not.toBe(true);
  return result!;
}

describe('collaborator execution retirement', () => {
  it.each([false, true])('preserves history, read-before-write, todos and shell state with persistence=%s', async persistSession => {
    const requests: ProviderRequest[] = [];
    let initialized = false;
    let continued = false;
    const llm = provider(request => {
      requests.push(request);
      if (!initialized) {
        initialized = true;
        return [
          { name: 'Read', input: { file_path: join(directory, 'facts.txt') } },
          { name: 'TodoWrite', input: { todos: [{ content: 'RETAINED_PENDING_WORK', status: 'pending', activeForm: 'Checking retained work' }] } },
          { name: 'Bash', input: { command: 'cd nested && export COLLAB_FIXTURE_VALUE=retained' } },
        ];
      }
      if (JSON.stringify(request.messages).includes('CONTINUE_WORK') && !continued) {
        continued = true;
        return [
          { name: 'Edit', input: { file_path: join(directory, 'facts.txt'), old_string: 'Original evidence.', new_string: 'Verified evidence.' } },
          { name: 'Bash', input: { command: 'printf "%s:%s" "$PWD" "$COLLAB_FIXTURE_VALUE"' } },
        ];
      }
      return [];
    });
    const { binding } = setup(llm, { persistSession });
    await call(binding, 'spawn_agent', { name: 'worker', prompt: 'Read the file and prepare work. FIRST_ASSIGNMENT_CONTEXT' });
    await settled(binding);
    expect(binding.residentCount).toBe(0);
    expect(binding.retainedCount).toBe(1);
    const record = await call(binding, 'team_read_member', { member: 'worker' });
    expect(record.content[0].text).toContain('FIRST_ASSIGNMENT_CONTEXT');
    binding.beginRequest();
    await call(binding, 'team_send', { to: 'worker', message: 'CONTINUE_WORK: finish the prior assignment.' });
    await settled(binding);
    expect(await readFile(join(directory, 'facts.txt'), 'utf8')).toBe('Verified evidence.');
    const continuation = requests.find(request => JSON.stringify(request.messages).includes('CONTINUE_WORK'));
    expect(JSON.stringify(continuation?.messages)).toContain('FIRST_ASSIGNMENT_CONTEXT');
    expect(JSON.stringify(continuation?.messages)).toContain('RETAINED_PENDING_WORK');
    const results = requests.at(-1)!.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter((block): block is ToolResultBlock => block.type === 'tool_result');
    expect(results.some(result => String(result.content).includes(`${join(directory, 'nested')}:retained`))).toBe(true);
    expect(results.every(result => !result.is_error)).toBe(true);
    expect(binding.residentCount).toBe(0);
    if (!persistSession) {
      await expect(access(join(directory, 'config', 'projects'))).rejects.toThrow();
      await expect(access(join(directory, 'config', 'todos'))).rejects.toThrow();
      await expect(access(join(directory, 'config', 'goals'))).rejects.toThrow();
    }
  });

  it('bounds idle sessions while retaining each member and its context', async () => {
    const requests: ProviderRequest[] = [];
    const { binding } = setup(provider(request => { requests.push(request); return []; }), {}, 1);
    for (let index = 0; index < 4; index++) {
      await call(binding, 'spawn_agent', { name: `member-${index}`, prompt: `INITIAL_CONTEXT_${index}` });
      await settled(binding);
      expect(binding.residentCount).toBe(1);
      expect(binding.retainedCount).toBe(index);
    }
    await call(binding, 'team_send', { to: 'member-0', message: 'Recall your initial assignment.' });
    await settled(binding);
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('INITIAL_CONTEXT_0');
    expect(binding.residentCount).toBe(1);
    expect(binding.retainedCount).toBe(3);
  });

  it('rebuilds a changed host capability without losing the member conversation', async () => {
    const requests: ProviderRequest[] = [];
    const versions: string[] = [];
    const probe = (version: string): Tool => ({ name: 'Probe', description: 'Inspect the configured host capability.', inputSchema: { type: 'object', properties: {} }, permissionLevel: 'none',
      async execute() { versions.push(version); return toolSuccess(`CAPABILITY_${version}`); } });
    const llm = provider(request => {
      requests.push(request);
      return requests.length === 1 || requests.length === 3 ? [{ name: 'Probe', input: {} }] : [];
    });
    const { binding, base } = setup(llm, { customTools: [probe('initial')] }, 1);
    await call(binding, 'spawn_agent', { name: 'worker', prompt: 'Check the host capability. RETAIN_THIS_ASSIGNMENT' });
    await settled(binding);
    base.customTools = [probe('replacement')];
    await call(binding, 'team_send', { to: 'worker', message: 'Check the host capability again.' });
    await settled(binding);
    expect(versions).toEqual(['initial', 'replacement']);
    expect(JSON.stringify(requests[2].messages)).toContain('RETAIN_THIS_ASSIGNMENT');
    expect(JSON.stringify(requests[2].messages)).toContain('CAPABILITY_initial');
  });

  it('keeps a background command and its output across retirement, and stops it through team_stop while no model is running', async () => {
    const requests: ProviderRequest[] = [];
    let taskId = '';
    let outputPath = '';
    const outputs: Array<{ task: { status: string; result: string } }> = [];
    const llm = provider(request => {
      requests.push(request);
      const results = request.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .filter((block): block is ToolResultBlock => block.type === 'tool_result');
      if (requests.length === 1) return [{ name: 'Bash', input: { run_in_background: true,
        command: 'node -e "console.log(\'BACKGROUND_READY\'); setInterval(() => {}, 1000)"' } }];
      if (requests.length === 2) {
        const output = String(results.at(-1)?.content);
        taskId = /ID: ([\w-]+)/.exec(output)?.[1] ?? '';
        outputPath = /Output file: (.+)/.exec(output)?.[1] ?? '';
      }
      if (requests.length === 3 || requests.length === 5) return [{ name: 'TaskOutput', input: { task_id: taskId, block: requests.length === 5, timeout: 2000 } }];
      if (requests.length === 4 || requests.length === 6) outputs.push(JSON.parse(String(results.at(-1)?.content)));
      return [];
    });
    const { binding } = setup(llm);
    await call(binding, 'spawn_agent', { name: 'worker', prompt: 'Start a background command.' });
    await settled(binding);
    expect(binding.residentCount).toBe(0);
    expect(taskId).not.toBe('');
    await vi.waitFor(async () => { expect(await readFile(outputPath, 'utf8')).toContain('BACKGROUND_READY'); }, { timeout: 3000 });
    await call(binding, 'team_send', { to: 'worker', message: 'Inspect the background command.' });
    await settled(binding);
    expect(outputs[0].task.status).toBe('running');
    expect(binding.residentCount).toBe(0);
    await call(binding, 'team_stop', { to: 'worker' });
    await call(binding, 'team_send', { to: 'worker', message: 'Inspect the stopped background command.' });
    await settled(binding);
    expect(outputs[1].task.status).toBe('stopped');
    expect(outputs[1].task.result).toContain('BACKGROUND_READY');
    await binding.close();
    await expect(access(outputPath)).rejects.toThrow();
  });
});
