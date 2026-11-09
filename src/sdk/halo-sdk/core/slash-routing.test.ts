/**
 * Slash-leading input routing through a real session and a single-turn
 * query: only an available command is handled locally; any other text that
 * happens to start with `/` reaches the model unchanged.
 */

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from './session.js';
import type { SDKSession } from './session.js';
import type { SDKMessage } from './query-types.js';
import { query } from '../index.js';
import type { Command } from '../commands/types.js';
import type {
  LlmProvider,
  ProviderRequest,
  ProviderResponse,
  StreamEvent,
  ProviderCapabilities,
  UsageInfo,
} from '../types/provider.js';

const CAPS: ProviderCapabilities = {
  streaming: true,
  toolCalling: true,
  thinking: false,
  imageInput: false,
  pdfInput: false,
  audioInput: false,
  videoInput: false,
  caching: false,
  systemPromptStyle: 'top_level',
};

function usage(): UsageInfo {
  return { input_tokens: 10, output_tokens: 5 };
}

function recordingProvider(): { provider: LlmProvider; requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  const provider: LlmProvider = {
    id: 'recording',
    name: 'Recording',
    capabilities: () => CAPS,
    async createMessage(): Promise<ProviderResponse> {
      return { id: `msg_${randomUUID()}`, content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: usage(), model: 'test-model' };
    },
    async *createMessageStream(req: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined> {
      requests.push(req);
      yield { type: 'message_start', id: `msg_${randomUUID()}`, model: 'test-model', usage: usage() };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'text_delta', index: 0, text: 'reply' };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: 'end_turn', usage: usage() };
      yield { type: 'message_stop' };
    },
  };
  return { provider, requests };
}

function lastUserText(req: ProviderRequest | undefined): string {
  const users = (req?.messages ?? []).filter((m) => m.role === 'user');
  const last = users[users.length - 1];
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  return last.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

const USER_COMMANDS: Command[] = [
  {
    type: 'local',
    name: 'echo',
    description: 'Echo the argument',
    source: 'builtin',
    async call(args) {
      if (!args) throw new Error('Usage: /echo <text>');
      return { kind: 'system', markdown: `echo: ${args}` };
    },
  },
  {
    type: 'local',
    name: 'off',
    description: 'Disabled command',
    source: 'builtin',
    isEnabled: () => false,
    async call() {
      return { kind: 'system', markdown: 'should not run' };
    },
  },
];

async function makeSession(provider: LlmProvider, cwd: string): Promise<SDKSession> {
  return createSession({
    provider,
    cwd,
    model: 'test-model',
    permissionMode: 'bypassPermissions',
    persistSession: false,
    tools: [],
    maxTurns: 2,
    systemPrompt: 'Test assistant.',
    slashCommands: USER_COMMANDS,
  } as Parameters<typeof createSession>[0]);
}

async function driveTurn(session: SDKSession): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = [];
  for await (const msg of session.stream()) {
    messages.push(msg);
    const raw = msg as unknown as Record<string, unknown>;
    if (raw.type === 'system' && raw.subtype === 'session_state_changed' && raw.state === 'idle') break;
    if (raw.type === 'result') break;
    if (messages.length > 200) throw new Error('turn did not settle');
  }
  return messages;
}

function resultOf(messages: SDKMessage[]): Record<string, unknown> | undefined {
  return messages.find((m) => m.type === 'result') as Record<string, unknown> | undefined;
}

const FORWARDED = [
  '/xx',
  '/uer/dsds',
  '/tmp/example.txt',
  '/Users/me/a.log 帮我看看这个日志',
  '/notacommand please explain',
];

describe('session slash routing', () => {
  for (const input of FORWARDED) {
    it(`forwards ${JSON.stringify(input)} to the model unchanged`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'halo-sdk-slash-'));
      const { provider, requests } = recordingProvider();
      const session = await makeSession(provider, dir);
      try {
        await session.send(input);
        const messages = await driveTurn(session);
        expect(requests).toHaveLength(1);
        expect(lastUserText(requests[0])).toBe(input);
        expect(resultOf(messages)?.is_error).not.toBe(true);
      } finally {
        session.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('runs a known command locally without calling the model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'halo-sdk-slash-'));
    const { provider, requests } = recordingProvider();
    const session = await makeSession(provider, dir);
    try {
      await session.send('/echo hi');
      const result = resultOf(await driveTurn(session));
      expect(requests).toHaveLength(0);
      expect(result).toMatchObject({ is_error: false, result: expect.stringContaining('echo: hi') });
    } finally {
      session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a known command\'s own argument error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'halo-sdk-slash-'));
    const { provider, requests } = recordingProvider();
    const session = await makeSession(provider, dir);
    try {
      await session.send('/echo');
      const result = resultOf(await driveTurn(session));
      expect(requests).toHaveLength(0);
      expect(result).toMatchObject({ is_error: true, result: expect.stringContaining('Usage: /echo <text>') });
    } finally {
      session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('explains a registered but unavailable command instead of sending it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'halo-sdk-slash-'));
    const { provider, requests } = recordingProvider();
    const session = await makeSession(provider, dir);
    try {
      await session.send('/off');
      const result = resultOf(await driveTurn(session));
      expect(requests).toHaveLength(0);
      expect(result).toMatchObject({ is_error: true, result: expect.stringContaining('/off is not available') });
    } finally {
      session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends plain text unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'halo-sdk-slash-'));
    const { provider, requests } = recordingProvider();
    const session = await makeSession(provider, dir);
    try {
      await session.send('hello /xx');
      await driveTurn(session);
      expect(lastUserText(requests[0])).toBe('hello /xx');
    } finally {
      session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('query slash routing', () => {
  for (const input of ['/uer/dsds', '/xx tell me more']) {
    it(`forwards ${JSON.stringify(input)} to the model unchanged`, async () => {
      const { provider, requests } = recordingProvider();
      const q = query({ prompt: input, options: { model: 'test-model', provider, maxTurns: 1, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, persistSession: false } });
      try {
        const messages: SDKMessage[] = [];
        for await (const m of q) messages.push(m);
        expect(requests).toHaveLength(1);
        expect(lastUserText(requests[0])).toBe(input);
        expect(resultOf(messages)?.is_error).not.toBe(true);
      } finally {
        q.close();
      }
    });
  }
});
