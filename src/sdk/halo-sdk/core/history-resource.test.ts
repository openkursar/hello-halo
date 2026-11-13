import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, type SDKSession } from '../index.js';
import type { LlmProvider } from '../types/provider.js';

describe('retained session history', () => {
  it.each([false, true])('carries a compaction summary into the next user turn (cached=%s)', async cached => {
    const directory = await mkdtemp(join(tmpdir(), 'sdk-history-resource-'));
    let calls = 0;
    let summaries = 0;
    let afterCompaction = '';
    const provider: LlmProvider = {
      id: 'test', name: 'test',
      capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false,
        pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
      async createMessage() {
        summaries++;
        return { id: 'summary', model: 'test', content: [{ type: 'text', text: 'SUMMARY_SENTINEL' }],
          stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } };
      },
      async *createMessageStream(request) {
        calls++;
        if (summaries) afterCompaction = JSON.stringify(request.messages);
        yield { type: 'message_start', id: String(calls), model: 'test', usage: { input_tokens: calls === 8 && !cached ? 8400 : 10, output_tokens: 1,
          cache_read_input_tokens: calls === 8 && cached ? 8390 : 0 } };
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
        yield { type: 'text_delta', index: 0, text: 'answer' };
        yield { type: 'content_block_stop', index: 0 };
        yield { type: 'message_delta', stopReason: 'end_turn' };
        yield { type: 'message_stop' };
      },
    };
    let session: SDKSession | undefined;
    try {
      session = await createSession({ provider, model: 'test', contextWindow: 10_000, maxOutputTokens: 1000, persistSession: false,
        tools: [], systemPrompt: 'Test', cwd: directory, settingSources: [], env: { HOME: directory },
        thinking: { type: 'disabled' }, turnEndChecks: { openWork: false, completion: false } });
      for (let turn = 0; turn < 9; turn++) {
        await session.send(`input-${turn}: ${'evidence '.repeat(600)}`);
        for await (const message of session.stream()) if (message.type === 'result') {
          expect(message, JSON.stringify(message)).toMatchObject({ is_error: false });
          break;
        }
      }
      expect(summaries).toBeGreaterThan(0);
      expect(afterCompaction).toContain('SUMMARY_SENTINEL');
    } finally { session?.close(); await session?.flush(); await rm(directory, { recursive: true, force: true }); }
  });
});
