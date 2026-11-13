/**
 * The tool context the loop hands to every tool call. These guarantees are
 * only real if the loop actually populates the context — a tool that reads an
 * always-undefined field silently disables itself.
 */

import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryLoop } from '../index.js';
import type { SDKMessage } from './query-types.js';
import type {
  LlmProvider,
  ProviderCapabilities,
  ProviderRequest,
  ProviderResponse,
  StreamEvent,
  UsageInfo,
} from '../types/provider.js';
import type { QueryConfig } from '../types/config.js';
import type { ToolContext } from '../types/tool.js';
import { WriteTool } from '../tools/write/index.js';
import { ReadTool } from '../tools/read/index.js';

const writeTool = new WriteTool();
const readTool = new ReadTool();

const TEST_CAPS: ProviderCapabilities = {
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

function makeUsage(): UsageInfo {
  return { input_tokens: 10, output_tokens: 20 };
}

function makeConfig(overrides: Partial<QueryConfig> = {}): QueryConfig {
  return {
    model: 'test-model',
    contextWindow: 200_000,
    maxTurns: 4,
    cwd: '/tmp',
    env: {},
    permissionMode: 'bypassPermissions',
    systemPrompt: 'You are a test assistant.',
    thinking: { type: 'disabled' },
    abortSignal: new AbortController().signal,
    ...overrides,
  } as QueryConfig;
}

/** Emit one scripted tool call per turn, then a final text answer. */
function makeScriptedProvider(
  calls: Array<{ name: string; input: Record<string, unknown> }>,
): LlmProvider {
  let turn = 0;
  return {
    id: 'scripted',
    name: 'Scripted',
    capabilities: () => TEST_CAPS,
    async createMessage(): Promise<ProviderResponse> {
      throw new Error('not used');
    },
    async *createMessageStream(req: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined> {
      const call = calls[turn];
      turn++;
      yield { type: 'message_start', id: `msg_${randomUUID()}`, model: req.model, usage: makeUsage() };
      if (!call) {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
        yield { type: 'text_delta', index: 0, text: 'done' };
        yield { type: 'content_block_stop', index: 0 };
        yield { type: 'message_delta', stopReason: 'end_turn', usage: makeUsage() };
        yield { type: 'message_stop' };
        return;
      }
      yield {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: `toolu_${turn}`, name: call.name, input: {} },
      };
      yield { type: 'input_json_delta', index: 0, partialJson: JSON.stringify(call.input) };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: 'tool_use', usage: makeUsage() };
      yield { type: 'message_stop' };
    },
  };
}

async function drain(gen: AsyncGenerator<SDKMessage>, limit = 80): Promise<SDKMessage[]> {
  const msgs: SDKMessage[] = [];
  for await (const m of gen) {
    msgs.push(m);
    if (msgs.length >= limit) break;
  }
  return msgs;
}

/** Text of every tool_result the loop fed back to the model. */
function toolResults(msgs: SDKMessage[]): string[] {
  const out: string[] = [];
  for (const m of msgs) {
    if (m.type !== 'user') continue;
    const content = (m as unknown as { message: { content: unknown } }).message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_result') out.push(String(block.content));
    }
  }
  return out;
}

describe('queryLoop — read-before-write', () => {
  it('refuses to overwrite a file the model never read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'halo-rbw-'));
    const file = join(dir, 'existing.txt');
    writeFileSync(file, 'original\n');

    try {
      const provider = makeScriptedProvider([
        { name: 'Write', input: { file_path: file, content: 'clobbered\n' } },
      ]);

      const msgs = await drain(
        queryLoop(makeConfig({ cwd: dir }), provider, [writeTool, readTool], 'overwrite it'),
      );

      expect(toolResults(msgs).join('\n')).toMatch(/read/i);
      expect(readFileSync(file, 'utf-8')).toBe('original\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows the write once the file has been read in an earlier turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'halo-rbw-'));
    const file = join(dir, 'existing.txt');
    writeFileSync(file, 'original\n');

    try {
      const provider = makeScriptedProvider([
        { name: 'Read', input: { file_path: file } },
        { name: 'Write', input: { file_path: file, content: 'updated\n' } },
      ]);

      await drain(queryLoop(makeConfig({ cwd: dir }), provider, [writeTool, readTool], 'update it'));

      // The record survives the turn boundary — that is the whole point of
      // holding it for the life of the run rather than rebuilding it per turn.
      expect(readFileSync(file, 'utf-8')).toBe('updated\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('queryLoop — tool context wiring', () => {
  it('reports file changes to the host', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'halo-ctx-'));
    const file = join(dir, 'new.txt');
    const recordFileChange = vi.fn();

    try {
      const provider = makeScriptedProvider([
        { name: 'Write', input: { file_path: file, content: 'hello\n' } },
      ]);

      await drain(
        queryLoop(makeConfig({ cwd: dir }), provider, [writeTool], 'create it', {
          recordFileChange,
        }),
      );

      expect(recordFileChange).toHaveBeenCalledTimes(1);
      expect(recordFileChange.mock.calls[0][0]).toBe(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes the host-declared extra directories to tools', async () => {
    const seen: ToolContext[] = [];
    const probe = {
      name: 'Probe',
      description: 'records its context',
      inputSchema: { type: 'object', properties: {} },
      permissionLevel: 'none' as const,
      async execute(_input: Record<string, unknown>, ctx: ToolContext) {
        seen.push(ctx);
        return { content: 'ok', isError: false };
      },
    };
    const provider = makeScriptedProvider([{ name: 'Probe', input: {} }]);

    await drain(
      queryLoop(
        makeConfig({ additionalDirectories: ['/srv/data', '/srv/logs'] }),
        provider,
        [probe],
        'probe',
      ),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0].additionalDirectories).toEqual(['/srv/data', '/srv/logs']);
  });

  it('passes the paths closed by Read rules to tools', async () => {
    const seen: ToolContext[] = [];
    const probe = {
      name: 'Probe',
      description: 'records its context',
      inputSchema: { type: 'object', properties: {} },
      permissionLevel: 'none' as const,
      async execute(_input: Record<string, unknown>, ctx: ToolContext) {
        seen.push(ctx);
        return { content: 'ok', isError: false };
      },
    };
    const provider = makeScriptedProvider([{ name: 'Probe', input: {} }]);

    await drain(queryLoop(makeConfig({ readDenyRoots: ['/srv/closed'] }), provider, [probe], 'probe'));

    expect(seen[0].readDenyRoots).toEqual(['/srv/closed']);
  });
});
