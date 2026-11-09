/**
 * Session-level scenario tests driving a real createSession with a
 * scripted LlmProvider. Each scenario exercises the Read/Write/Edit
 * read-state contract, the image pathway, and the Read truncation
 * contract across one or more `send()` turns.
 *
 * Scenarios 1-5 assert the currently-known defective behaviour (red
 * until the fixes land). Scenario 6 is a guard: the mtime freshness
 * check must survive the read-state sessionization fix.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession } from './session.js';
import type { SDKSession } from './session.js';
import type { SDKMessage } from './query-types.js';
import type {
  LlmProvider,
  ProviderRequest,
  ProviderResponse,
  StreamEvent,
  ProviderCapabilities,
  UsageInfo,
} from '../types/provider.js';

// ---------------------------------------------------------------------------
// Scripted provider
// ---------------------------------------------------------------------------

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

function makeUsage(input = 10, output = 20): UsageInfo {
  return { input_tokens: input, output_tokens: output };
}

function textStream(text: string): StreamEvent[] {
  return [
    { type: 'message_start', id: `msg_${randomUUID()}`, model: 'test-model', usage: makeUsage() },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'text_delta', index: 0, text },
    { type: 'content_block_stop', index: 0 },
  ];
}

function toolUseStream(
  toolName: string,
  input: Record<string, unknown>,
  toolUseId = `toolu_${randomUUID().slice(0, 8)}`,
): StreamEvent[] {
  return [
    { type: 'message_start', id: `msg_${randomUUID()}`, model: 'test-model', usage: makeUsage() },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: toolUseId, name: toolName, input: {} },
    },
    { type: 'input_json_delta', index: 0, partialJson: JSON.stringify(input) },
    { type: 'content_block_stop', index: 0 },
  ];
}

interface Reply {
  events: StreamEvent[];
  stop?: 'end_turn' | 'tool_use';
}

/**
 * Provider that plays the given replies in order (repeating the last one)
 * and records every ProviderRequest it receives.
 */
function makeScriptedProvider(
  replies: Reply[],
  caps: ProviderCapabilities = TEST_CAPS,
): { provider: LlmProvider; requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  let callIndex = 0;
  const provider: LlmProvider = {
    id: 'scripted',
    name: 'Scripted',
    capabilities: () => caps,
    async createMessage(_req: ProviderRequest): Promise<ProviderResponse> {
      return {
        id: `msg_${randomUUID()}`,
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: makeUsage(),
        model: 'test-model',
      };
    },
    async *createMessageStream(
      req: ProviderRequest,
    ): AsyncGenerator<StreamEvent, void, undefined> {
      requests.push(req);
      const reply = replies[Math.min(callIndex, replies.length - 1)];
      callIndex++;
      yield* reply.events;
      yield { type: 'message_delta', stopReason: reply.stop ?? 'end_turn', usage: makeUsage() };
      yield { type: 'message_stop' };
    },
  };
  return { provider, requests };
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

async function makeSession(
  provider: LlmProvider,
  cwd: string,
): Promise<SDKSession> {
  return createSession({
    provider,
    cwd,
    model: 'test-model',
    permissionMode: 'bypassPermissions',
    persistSession: false,
    tools: ['Read', 'Write', 'Edit'],
    maxTurns: 10,
    systemPrompt: 'Test assistant.',
  } as Parameters<typeof createSession>[0]);
}

interface ToolResultBlock {
  tool_use_id: string;
  content: unknown;
}

/** Drive one turn: collect messages until the session goes idle. */
async function driveTurn(session: SDKSession): Promise<{
  messages: SDKMessage[];
  toolResults: ToolResultBlock[];
}> {
  const messages: SDKMessage[] = [];
  const toolResults: ToolResultBlock[] = [];
  for await (const msg of session.stream()) {
    messages.push(msg);
    if (msg.type === 'user') {
      const content = (msg.message as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === 'tool_result') {
            toolResults.push({
              tool_use_id: block.tool_use_id as string,
              content: block.content,
            });
          }
        }
      }
    }
    if (
      msg.type === 'system' &&
      (msg as unknown as Record<string, unknown>).subtype === 'session_state_changed' &&
      (msg as unknown as Record<string, unknown>).state === 'idle'
    ) {
      break;
    }
    if (messages.length > 500) throw new Error('turn did not reach idle');
  }
  return { messages, toolResults };
}

function resultText(result: ToolResultBlock | undefined): string {
  if (typeof result?.content === 'string') return result.content;
  return JSON.stringify(result?.content ?? null);
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'halo-sdk-scenarios-'));
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('session scenarios — read-state across sends', () => {
  it('1. Write in send#1, Edit in send#2: the edit must succeed', async () => {
    const dir = tempDir();
    const filePath = join(dir, 'a.txt');
    const { provider } = makeScriptedProvider([
      { events: toolUseStream('Write', { file_path: filePath, content: 'hello world\n' }), stop: 'tool_use' },
      { events: textStream('written') },
      { events: toolUseStream('Edit', { file_path: filePath, old_string: 'hello', new_string: 'goodbye' }), stop: 'tool_use' },
      { events: textStream('edited') },
    ]);
    const session = await makeSession(provider, dir);
    try {
      await session.send('create the file');
      await driveTurn(session);
      await session.send('now edit it');
      const turn2 = await driveTurn(session);

      const editResult = turn2.toolResults[0];
      expect(editResult, 'Edit tool_result must be present').toBeDefined();
      expect(resultText(editResult)).not.toContain('File has not been read yet');
    } finally {
      session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2. full Read in send#1, Edit in send#2: the edit must succeed', async () => {
    const dir = tempDir();
    const filePath = join(dir, 'b.txt');
    writeFileSync(filePath, 'hello world\n');
    const { provider } = makeScriptedProvider([
      { events: toolUseStream('Read', { file_path: filePath }), stop: 'tool_use' },
      { events: textStream('read') },
      { events: toolUseStream('Edit', { file_path: filePath, old_string: 'hello', new_string: 'goodbye' }), stop: 'tool_use' },
      { events: textStream('edited') },
    ]);
    const session = await makeSession(provider, dir);
    try {
      await session.send('read the file');
      await driveTurn(session);
      await session.send('now edit it');
      const turn2 = await driveTurn(session);

      const editResult = turn2.toolResults[0];
      expect(editResult, 'Edit tool_result must be present').toBeDefined();
      expect(resultText(editResult)).not.toContain('File has not been read yet');
    } finally {
      session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3. partial Read (offset/limit) followed by Edit in the same send: the edit must succeed', async () => {
    const dir = tempDir();
    const filePath = join(dir, 'c.txt');
    writeFileSync(filePath, 'line one\nline two\nline three\n');
    const { provider } = makeScriptedProvider([
      { events: toolUseStream('Read', { file_path: filePath, offset: 1, limit: 2 }), stop: 'tool_use' },
      { events: toolUseStream('Edit', { file_path: filePath, old_string: 'line two', new_string: 'LINE TWO' }), stop: 'tool_use' },
      { events: textStream('done') },
    ]);
    const session = await makeSession(provider, dir);
    try {
      await session.send('read part of the file, then edit it');
      const turn = await driveTurn(session);

      const editResult = turn.toolResults[1];
      expect(editResult, 'Edit tool_result must be present').toBeDefined();
      expect(resultText(editResult)).not.toContain('File has not been read yet');
    } finally {
      session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('full Read in one send authorizes Write in the next send', async () => {
    const dir = tempDir();
    const filePath = join(dir, 'write-across-turns.txt');
    writeFileSync(filePath, 'before\n');
    const { provider } = makeScriptedProvider([
      { events: toolUseStream('Read', { file_path: filePath }), stop: 'tool_use' },
      { events: textStream('read') },
      { events: toolUseStream('Write', { file_path: filePath, content: 'after\n' }), stop: 'tool_use' },
      { events: textStream('written') },
    ]);
    const session = await makeSession(provider, dir);
    try {
      await session.send('read the file');
      await driveTurn(session);
      await session.send('write the file');
      const turn = await driveTurn(session);
      expect(resultText(turn.toolResults[0])).toContain(`Wrote ${filePath}`);
      expect(readFileSync(filePath, 'utf-8')).toBe('after\n');
    } finally {
      session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clearing conversation history revokes Read authorization until another Read', async () => {
    const dir = tempDir();
    const filePath = join(dir, 'clear.txt');
    writeFileSync(filePath, 'before\n');
    const { provider } = makeScriptedProvider([
      { events: toolUseStream('Read', { file_path: filePath }), stop: 'tool_use' },
      { events: textStream('read') },
      { events: toolUseStream('Write', { file_path: filePath, content: 'blind write\n' }), stop: 'tool_use' },
      { events: textStream('write rejected') },
      { events: toolUseStream('Read', { file_path: filePath }), stop: 'tool_use' },
      { events: textStream('read again') },
      { events: toolUseStream('Write', { file_path: filePath, content: 'authorized write\n' }), stop: 'tool_use' },
      { events: textStream('written') },
    ]);
    const session = await makeSession(provider, dir);
    try {
      await session.send('read the file');
      await driveTurn(session);
      await session.send('/clear');
      await driveTurn(session);
      await session.send('overwrite without another read');
      const denied = await driveTurn(session);
      expect(resultText(denied.toolResults[0])).toContain('Write requires a complete Read');
      expect(readFileSync(filePath, 'utf-8')).toBe('before\n');

      await session.send('read the file again');
      await driveTurn(session);
      await session.send('overwrite after the new read');
      const allowed = await driveTurn(session);
      expect(resultText(allowed.toolResults[0])).toContain(`Wrote ${filePath}`);
      expect(readFileSync(filePath, 'utf-8')).toBe('authorized write\n');
    } finally {
      session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('partial Read does not authorize whole-file Write across sends but permits precise Edit', async () => {
    const dir = tempDir();
    const filePath = join(dir, 'partial-write.txt');
    writeFileSync(filePath, 'seen\nunseen important text\n');
    const { provider } = makeScriptedProvider([
      { events: toolUseStream('Read', { file_path: filePath, limit: 1 }), stop: 'tool_use' },
      { events: textStream('read first line') },
      { events: toolUseStream('Write', { file_path: filePath, content: 'replacement\n' }), stop: 'tool_use' },
      { events: textStream('write rejected') },
      { events: toolUseStream('Edit', { file_path: filePath, old_string: 'seen\n', new_string: 'SEEN\n' }), stop: 'tool_use' },
      { events: textStream('edited') },
    ]);
    const session = await makeSession(provider, dir);
    try {
      await session.send('read the first line');
      await driveTurn(session);
      await session.send('replace the whole file');
      const denied = await driveTurn(session);
      expect(resultText(denied.toolResults[0])).toContain('Write requires a complete Read');
      expect(readFileSync(filePath, 'utf-8')).toBe('seen\nunseen important text\n');

      await session.send('edit just the seen text');
      const allowed = await driveTurn(session);
      expect(resultText(allowed.toolResults[0])).toContain('Successfully edited');
      expect(readFileSync(filePath, 'utf-8')).toBe('SEEN\nunseen important text\n');
    } finally {
      session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('6. mtime freshness check survives across sends (guard)', async () => {
    const dir = tempDir();
    const filePath = join(dir, 'fresh.txt');
    writeFileSync(filePath, 'original content\n');
    const { provider } = makeScriptedProvider([
      { events: toolUseStream('Read', { file_path: filePath }), stop: 'tool_use' },
      { events: textStream('read') },
      { events: toolUseStream('Edit', { file_path: filePath, old_string: 'original', new_string: 'changed' }), stop: 'tool_use' },
      { events: textStream('edited') },
    ]);
    const session = await makeSession(provider, dir);
    try {
      await session.send('read the file');
      await driveTurn(session);

      // Change the bytes AND push mtime into the future after the read —
      // a spurious mtime bump alone is absorbed by the content-unchanged
      // fallback for full reads.
      writeFileSync(filePath, 'tampered content\n');
      const future = new Date(Date.now() + 60_000);
      utimesSync(filePath, future, future);

      await session.send('now edit it');
      const turn2 = await driveTurn(session);

      const editResult = turn2.toolResults[0];
      expect(editResult, 'Edit tool_result must be present').toBeDefined();
      expect(resultText(editResult)).toContain('The file no longer matches its recorded read');
    } finally {
      session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('session scenarios — Read truncation contract', () => {
  it('4. oversized file read without params: line-window footer, no mid-marker', async () => {
    const dir = tempDir();
    const filePath = join(dir, 'big.txt');
    // 1500 lines x ~100 chars = ~150k chars, under the 2000-line cap but
    // far over the 50k-char tool-result budget.
    const lines = Array.from({ length: 1500 }, (_, i) =>
      `line-${String(i).padStart(4, '0')}-${'x'.repeat(90)}`,
    );
    writeFileSync(filePath, `${lines.join('\n')}\n`);
    const { provider } = makeScriptedProvider([
      { events: toolUseStream('Read', { file_path: filePath }), stop: 'tool_use' },
      { events: textStream('read') },
    ]);
    const session = await makeSession(provider, dir);
    try {
      await session.send('read the whole file');
      const turn = await driveTurn(session);

      const readResult = turn.toolResults[0];
      expect(readResult, 'Read tool_result must be present').toBeDefined();
      const text = resultText(readResult);
      expect(text).not.toContain('[Content truncated:');
      expect(text).toMatch(/showing lines 1-\d+ of \d+\. Use offset=\d+ to continue reading/);
    } finally {
      session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('session scenarios — image pathway', () => {
  it('5. Read of a PNG reaches the provider as an image block in tool_result', async () => {
    const dir = tempDir();
    const filePath = join(dir, 'pixel.png');
    // Minimal valid 1x1 transparent PNG.
    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    writeFileSync(filePath, pngBytes);
    const readToolUseId = 'toolu_read_image_1';
    const { provider, requests } = makeScriptedProvider(
      [
        { events: toolUseStream('Read', { file_path: filePath }, readToolUseId), stop: 'tool_use' },
        { events: textStream('seen') },
      ],
      { ...TEST_CAPS, imageInput: true },
    );
    const session = await makeSession(provider, dir);
    try {
      await session.send('look at this image');
      await driveTurn(session);

      // Find the tool_result for our Read call in the recorded requests.
      let block: unknown;
      for (const req of requests) {
        for (const msg of req.messages) {
          const content = (msg as { content?: unknown }).content;
          if (!Array.isArray(content)) continue;
          for (const b of content as Array<Record<string, unknown>>) {
            if (b.type === 'tool_result' && b.tool_use_id === readToolUseId) {
              block = b.content;
            }
          }
        }
      }
      expect(block, 'tool_result for the Read call must reach the provider').toBeDefined();
      expect(Array.isArray(block)).toBe(true);
      const blocks = block as Array<Record<string, unknown>>;
      expect(blocks.some((b) => b.type === 'image')).toBe(true);
    } finally {
      session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
