import { describe, expect, it, vi } from 'vitest';
import { StreamWriter } from './stream.js';
import type { SDKMessage } from '../core/query-types.js';

describe('worker stream budgets', () => {
  it('refuses an oversized event before posting any part to the host', async () => {
    const send = vi.fn();
    const stream = new StreamWriter('session', 'stream', send);
    const event = { type: 'assistant', message: { content: 'x'.repeat(32 * 1024 * 1024) } } as unknown as SDKMessage;
    await expect(stream.push(event)).rejects.toThrow('transport limit');
    expect(send).not.toHaveBeenCalled();
    stream.stop();
  });

  it('backpressures the producer until the previous batch is acknowledged', async () => {
    const batches: any[] = [];
    const stream = new StreamWriter('session', 'stream', batch => batches.push(batch));
    const event = { type: 'system', subtype: 'fixture' } as unknown as SDKMessage;
    for (let i = 0; i < 64; i++) await stream.push(event);
    let advanced = false;
    const pending = stream.push(event).then(() => { advanced = true; });
    await Promise.resolve();
    expect(batches).toHaveLength(1);
    expect(advanced).toBe(false);
    stream.ack(batches[0].sequence);
    await pending;
    expect(advanced).toBe(true);
    stream.stop();
  });
});
