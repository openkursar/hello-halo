import { describe, expect, it } from 'vitest';
import { createHostCallbacks } from './host-callbacks.js';
import { callbackError } from './binding.js';
import { decodeWire, encodeWire } from './wire.js';

describe('host callback failure receipts', () => {
  for (const method of ['call', 'callData']) {
    it(`settles ${method} without replacing an uninspectable rejection`, async () => {
      const original = Object.defineProperty({}, 'name', { get() { throw new Error('Uninspectable rejection'); } });
      const host = createHostCallbacks(async () => { throw original; }, { preserveErrors: true });
      let completions = 0;
      const input = JSON.stringify(method === 'callData' ? { params: encodeWire({}) } : {});
      try {
        const raw = await new Promise<string>(resolve => {
          host.callback(null, method, input, true, value => { completions++; resolve(value); });
        });
        const reply = JSON.parse(raw);
        expect(reply.ok).toBe(false);
        const detail = reply.encoding ? decodeWire(reply.error) : reply.error;
        const error = new Error(JSON.stringify({ code: 'HOST_CALLBACK', message: 'Callback failed', details: detail }));
        expect(host.error(error)).toBe(original);
        expect(completions).toBe(1);
        host.release();
        expect(host.error(error)).not.toBe(original);
      } finally { host.release(); }
    });
  }

  it('does not inspect or retain a rejection arriving after its owner released', async () => {
    let reject!: (error: unknown) => void;
    const pending = new Promise((_resolve, fail) => { reject = fail; });
    const host = createHostCallbacks(() => pending, { preserveErrors: true });
    let reads = 0, completions = 0;
    const original = Object.defineProperty({}, 'name', { get() { reads++; throw new Error('Late rejection was inspected'); } });
    const result = new Promise<string>(resolve => {
      host.callback(null, 'call', '{}', true, value => { completions++; resolve(value); });
    });
    host.release();
    reject(original);
    expect(JSON.parse(await result).error.code).toBe('ABORTED');
    expect(reads).toBe(0);
    expect(completions).toBe(1);
    expect(host.isOriginal(original)).toBe(false);
  });

  it('keeps error encoding bounded even when a metadata getter throws its own object', () => {
    let reads = 0;
    const original = Object.defineProperty({}, 'name', { get() { reads++; throw original; } });
    expect(JSON.parse(callbackError(original)).code).toBe('HOST_CALLBACK_ERROR_ENCODING');
    expect(reads).toBe(2);
  });
});
