/**
 * Unit tests for image-bearing tool results: structured tool_result content,
 * and its survival across the transcript round-trip used by session resume.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildToolResultMessage, ensureToolResultPairing } from './messages.js';
import { TranscriptWriter, getTranscriptPath, type TranscriptOptions } from './transcript.js';
import { readHistory } from './transcript-reader.js';
import type { Message } from '../types/provider.js';

/** A stored session's history as resume reads it; null when nothing is stored. */
async function readStoredHistory(sessionId: string, cwd: string, stopAtMessageUuid?: string, options?: TranscriptOptions): Promise<Message[] | null> {
  try {
    return await readHistory(getTranscriptPath(sessionId, cwd, options), stopAtMessageUuid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

let tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tempDirs = [];
  delete process.env.CLAUDE_CONFIG_DIR;
});

describe('buildToolResultMessage with images', () => {
  it('keeps string content for results without images', () => {
    const msg = buildToolResultMessage([
      { toolUseId: 'tu_1', content: 'plain text', isError: false },
    ]);
    const block = (msg.content as Array<{ type: string }>)[0] as {
      type: string; content: unknown;
    };
    expect(block.type).toBe('tool_result');
    expect(block.content).toBe('plain text');
  });

  it('builds structured content (text + image blocks) when images are present', () => {
    const msg = buildToolResultMessage([
      {
        toolUseId: 'tu_1',
        content: 'screenshot attached',
        isError: false,
        images: [{ mimeType: 'image/png', data: 'aGk=' }],
      },
    ]);
    const block = (msg.content as Array<Record<string, unknown>>)[0];
    expect(block.type).toBe('tool_result');
    const blocks = block.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'text', text: 'screenshot attached' });
    expect(blocks[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aGk=' },
    });
  });

  it('emits no empty text block when the text body is empty and images exist', () => {
    // A pure-image MCP result has content === ''. An empty text block would
    // be rejected by the API — only the image block may remain.
    const msg = buildToolResultMessage([
      {
        toolUseId: 'tu_1',
        content: '',
        isError: false,
        images: [{ mimeType: 'image/png', data: 'aGk=' }],
      },
    ]);
    const block = (msg.content as Array<Record<string, unknown>>)[0];
    const blocks = block.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('image');
  });
});

describe('image tool_result survives the resume round-trip', () => {
  it('preserves structured content through transcript write → read → pairing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-img-transcript-'));
    tempDirs.push(dir);
    process.env.CLAUDE_CONFIG_DIR = dir;

    const sessionId = randomUUID();
    const toolResultMsg = buildToolResultMessage([
      {
        toolUseId: 'tu_img',
        content: 'screenshot',
        isError: false,
        images: [{ mimeType: 'image/png', data: 'aGk=' }],
      },
    ]);

    const writer = new TranscriptWriter(sessionId, '/test/project/dir');
    await writer.writeAssistantMessage({
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tu_img', name: 'Read', input: { file_path: '/x.png' } },
      ],
    });
    await writer.writeUserMessage(toolResultMsg);
    await writer.flush();

    const loaded = await readStoredHistory(sessionId, '/test/project/dir');
    expect(loaded).not.toBeNull();
    expect(loaded).toHaveLength(2);

    // Pairing repair must not strip or flatten the structured content.
    const repaired = ensureToolResultPairing(loaded!);
    expect(repaired).toHaveLength(2);
    const userMsg = repaired[1] as Message;
    const blocks = (userMsg.content as Array<Record<string, unknown>>)[0] as {
      type: string; content: Array<Record<string, unknown>>;
    };
    expect(blocks.type).toBe('tool_result');
    const imageBlock = blocks.content.find((b) => b.type === 'image') as {
      source: { media_type: string; data: string };
    };
    expect(imageBlock?.source).toEqual({
      type: 'base64',
      media_type: 'image/png',
      data: 'aGk=',
    });
  });

  it('preserves an image-only tool_result (empty text body) through the round-trip', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-img-transcript-'));
    tempDirs.push(dir);
    process.env.CLAUDE_CONFIG_DIR = dir;

    const sessionId = randomUUID();
    const toolResultMsg = buildToolResultMessage([
      {
        toolUseId: 'tu_img_only',
        content: '',
        isError: false,
        images: [{ mimeType: 'image/png', data: 'aGk=' }],
      },
    ]);

    const writer = new TranscriptWriter(sessionId, '/test/project/dir');
    await writer.writeAssistantMessage({
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tu_img_only', name: 'mcp__srv__shot', input: {} },
      ],
    });
    await writer.writeUserMessage(toolResultMsg);
    await writer.flush();

    const loaded = await readStoredHistory(sessionId, '/test/project/dir');
    const repaired = ensureToolResultPairing(loaded!);
    expect(repaired).toHaveLength(2);
    const userMsg = repaired[1] as Message;
    const block = (userMsg.content as Array<Record<string, unknown>>)[0] as {
      type: string; content: Array<Record<string, unknown>>;
    };
    expect(block.type).toBe('tool_result');
    expect(block.content).toHaveLength(1);
    expect(block.content[0].type).toBe('image');
  });
});
