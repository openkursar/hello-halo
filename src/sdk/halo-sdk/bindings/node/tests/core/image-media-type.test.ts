import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';

import { queryLoop } from '../../index.js';
import type { LlmProvider, Message, ProviderRequest, StreamEvent } from '../../types/provider.js';
import type { QueryConfig } from '../../types/config.js';

const base64 = (bytes: number[], pad = 32) => Buffer.from([...bytes, ...new Array(pad).fill(0)]).toString('base64');
const PNG = base64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = base64([0xff, 0xd8, 0xff, 0xe0]);
const GIF = base64([...Buffer.from('GIF89a')]);
const WEBP = base64([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')]);
const image = (data: string, media_type: string) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type, data } });

describe('queryLoop — mislabeled images', () => {
  it('sends images under the type their bytes have', async () => {
    const requests: ProviderRequest[] = [];
    const provider: LlmProvider = {
      id: 'capture', name: 'Capture',
      capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: true, pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
      async createMessage() { throw new Error('not used'); },
      async *createMessageStream(req: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined> {
        requests.push(req);
        yield { type: 'message_start', id: `msg_${randomUUID()}`, model: req.model, usage: { input_tokens: 1, output_tokens: 1 } };
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
        yield { type: 'text_delta', index: 0, text: 'seen' };
        yield { type: 'content_block_stop', index: 0 };
        yield { type: 'message_delta', stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
        yield { type: 'message_stop' };
      },
    };
    const config = {
      model: 'test-model', contextWindow: 200_000, maxTurns: 2, cwd: '/tmp', env: {}, permissionMode: 'bypassPermissions',
      systemPrompt: 'Test.', thinking: { type: 'disabled' }, abortSignal: new AbortController().signal,
    } as QueryConfig;
    let kept: Message[] | undefined;
    for await (const _ of queryLoop(config, provider, [], [{ role: 'user', content: [image(PNG, 'image/jpeg')] }], { onHistoryCompacted: history => { kept = [...history]; } })) { /* drain */ }
    expect(JSON.stringify(requests[0].messages)).toContain('"media_type":"image/png"');
    // The session keeps the corrected label, so a later turn has nothing left to relabel.
    expect(kept).toBeDefined();
    expect(JSON.stringify(kept)).toContain('"media_type":"image/png"');
    requests.length = 0;
    for await (const _ of queryLoop(config, provider, [], kept!)) { /* drain */ }
    expect(JSON.stringify(requests[0].messages)).toContain('"media_type":"image/png"');
  });
});
