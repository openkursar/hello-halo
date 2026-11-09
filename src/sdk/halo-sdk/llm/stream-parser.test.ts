/**
 * @module llm/stream-parser.test
 * Unit tests for the SSE stream parser.
 */

import { describe, it, expect, vi } from 'vitest';
import { parseSSEStream } from './stream-parser.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

/** Build a Response whose body emits the given string chunks in order. */
function makeResponse(...chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream);
}

/** Collect all yielded values from parseSSEStream. */
async function collect(
  response: Response,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  for await (const item of parseSSEStream(response, signal)) {
    items.push(item);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Basic JSON parsing
// ---------------------------------------------------------------------------

describe('parseSSEStream — basic parsing', () => {
  it('yields a single JSON object from a data: line', async () => {
    const items = await collect(makeResponse('data: {"type":"text"}\n\n'));
    expect(items).toEqual([{ type: 'text' }]);
  });

  it('yields multiple objects from sequential data: lines', async () => {
    const items = await collect(
      makeResponse('data: {"i":0}\ndata: {"i":1}\ndata: {"i":2}\n\n'),
    );
    expect(items).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
  });

  it('handles data: with no space after the colon', async () => {
    const items = await collect(makeResponse('data:{"compact":true}\n\n'));
    expect(items).toEqual([{ compact: true }]);
  });

  it('trims trailing whitespace from lines', async () => {
    const items = await collect(makeResponse('data: {"x":1}  \n\n'));
    expect(items).toEqual([{ x: 1 }]);
  });

  it('handles nested objects and arrays', async () => {
    const payload = { a: [1, 2, 3], b: { c: 'hello' } };
    const items = await collect(
      makeResponse(`data: ${JSON.stringify(payload)}\n\n`),
    );
    expect(items).toEqual([payload]);
  });
});

// ---------------------------------------------------------------------------
// [DONE] sentinel
// ---------------------------------------------------------------------------

describe('parseSSEStream — [DONE] sentinel', () => {
  it('stops yielding when [DONE] is encountered', async () => {
    const items = await collect(
      makeResponse('data: {"i":0}\ndata: [DONE]\ndata: {"i":1}\n\n'),
    );
    expect(items).toEqual([{ i: 0 }]);
  });

  it('stops immediately on [DONE] even with more chunks queued', async () => {
    // Two separate network chunks; the second arrives after [DONE]
    const items = await collect(
      makeResponse(
        'data: {"first":true}\ndata: [DONE]\n',
        'data: {"second":true}\n',
      ),
    );
    expect(items).toEqual([{ first: true }]);
  });

  it('handles [DONE] as the only event', async () => {
    const items = await collect(makeResponse('data: [DONE]\n\n'));
    expect(items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// event: prefix
// ---------------------------------------------------------------------------

describe('parseSSEStream — event: prefix', () => {
  it('attaches __event field to the following data object', async () => {
    const items = await collect(
      makeResponse('event: content_block_start\ndata: {"index":0}\n\n'),
    );
    expect(items).toEqual([{ index: 0, __event: 'content_block_start' }]);
  });

  it('clears __event after attaching — not propagated to the next data object', async () => {
    const items = await collect(
      makeResponse(
        'event: ping\ndata: {"type":"ping"}\ndata: {"type":"other"}\n\n',
      ),
    );
    expect(items[0]).toHaveProperty('__event', 'ping');
    expect(items[1]).not.toHaveProperty('__event');
  });

  it('data without a preceding event: has no __event field', async () => {
    const items = await collect(makeResponse('data: {"plain":true}\n\n'));
    expect(items[0]).not.toHaveProperty('__event');
  });

  it('handles event: with extra whitespace in the value', async () => {
    const items = await collect(
      makeResponse('event:  message_delta  \ndata: {"d":1}\n\n'),
    );
    expect(items[0]).toHaveProperty('__event', 'message_delta');
  });
});

// ---------------------------------------------------------------------------
// Skipped lines
// ---------------------------------------------------------------------------

describe('parseSSEStream — skipped lines', () => {
  it('skips empty lines (SSE event boundary)', async () => {
    const items = await collect(
      makeResponse('data: {"a":1}\n\n\n\ndata: {"b":2}\n\n'),
    );
    expect(items).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('skips SSE comments (lines starting with :)', async () => {
    const items = await collect(
      makeResponse(
        ': this is a comment\ndata: {"ok":true}\n: another comment\n\n',
      ),
    );
    expect(items).toEqual([{ ok: true }]);
  });

  it('ignores lines without a known prefix', async () => {
    const items = await collect(
      makeResponse('unknown: value\ndata: {"reached":true}\n\n'),
    );
    expect(items).toEqual([{ reached: true }]);
  });

  it('skips data: lines with empty payload', async () => {
    const items = await collect(
      makeResponse('data:   \ndata: {"after":true}\n\n'),
    );
    expect(items).toEqual([{ after: true }]);
  });
});

// ---------------------------------------------------------------------------
// Chunked data (split across network reads)
// ---------------------------------------------------------------------------

describe('parseSSEStream — chunked data', () => {
  it('reassembles a JSON payload split across two reads', async () => {
    // Split in the middle of the JSON string
    const items = await collect(
      makeResponse('data: {"split":', 'true}\n\n'),
    );
    expect(items).toEqual([{ split: true }]);
  });

  it('reassembles when the newline is in the next chunk', async () => {
    const items = await collect(
      makeResponse('data: {"x":1}', '\ndata: {"x":2}\n\n'),
    );
    expect(items).toEqual([{ x: 1 }, { x: 2 }]);
  });

  it('handles multiple complete events in a single read', async () => {
    const items = await collect(
      makeResponse(
        'data: {"n":1}\ndata: {"n":2}\ndata: {"n":3}\n\n',
      ),
    );
    expect(items).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('handles events spread across many small reads', async () => {
    const full = 'data: {"msg":"hello"}\n\n';
    // One character per chunk
    const chars = full.split('').map(String);
    const items = await collect(makeResponse(...chars));
    expect(items).toEqual([{ msg: 'hello' }]);
  });

  it('handles event: split across chunks', async () => {
    const items = await collect(
      makeResponse('event: messa', 'ge_start\ndata: {"id":"1"}\n\n'),
    );
    expect(items).toEqual([{ id: '1', __event: 'message_start' }]);
  });
});

// ---------------------------------------------------------------------------
// Malformed JSON
// ---------------------------------------------------------------------------

describe('parseSSEStream — malformed JSON', () => {
  it('skips a malformed data line without throwing', async () => {
    const items = await collect(
      makeResponse(
        'data: {bad json}\ndata: {"good":true}\n\n',
      ),
    );
    expect(items).toEqual([{ good: true }]);
  });

  it('skips multiple malformed lines and continues', async () => {
    const items = await collect(
      makeResponse(
        'data: !!!\ndata: undefined\ndata: {"ok":1}\n\n',
      ),
    );
    expect(items).toEqual([{ ok: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// AbortSignal
// ---------------------------------------------------------------------------

describe('parseSSEStream — AbortSignal', () => {
  it('throws when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(collect(
      makeResponse('data: {"should_not":"appear"}\n\n'),
      ac.signal,
    )).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('cancels a pending read and throws the cancellation reason', async () => {
    const ac = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode('data: {"n":1}\n\n')); },
      cancel,
    });
    const events = parseSSEStream(new Response(body), ac.signal);
    expect((await events.next()).value).toEqual({ n: 1 });
    const pending = events.next();
    const rejection = expect(pending).rejects.toThrow('cancelled by caller');
    ac.abort(new Error('cancelled by caller'));
    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it('cancels and releases the reader when the consumer stops early', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode('data: {"n":1}\n\n')); },
      cancel,
    });
    for await (const _event of parseSSEStream(new Response(body))) break;
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it('cancels an open body after the DONE sentinel', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); },
      cancel,
    });
    expect(await collect(new Response(body))).toEqual([]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge cases — response body
// ---------------------------------------------------------------------------

describe('parseSSEStream — edge cases', () => {
  it('throws when response.body is null', async () => {
    const noBody = { body: null } as unknown as Response;
    await expect(
      collect(noBody),
    ).rejects.toThrow('Response body is not readable');
  });

  it('throws when response.body is undefined', async () => {
    const noBody = {} as unknown as Response;
    await expect(
      collect(noBody),
    ).rejects.toThrow('Response body is not readable');
  });

  it('releases the reader lock even when stream ends normally', async () => {
    const releaseLock = vi.fn();
    const mockReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({
          done: false,
          value: encoder.encode('data: {"ok":true}\n\n'),
        })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      releaseLock,
    };
    const mockResponse = {
      body: { getReader: () => mockReader },
    } as unknown as Response;

    await collect(mockResponse);

    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it('releases the reader lock when an exception occurs mid-stream', async () => {
    const releaseLock = vi.fn();
    const mockReader = {
      read: vi.fn(async () => {
        throw new Error('network failure');
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
      releaseLock,
    };
    const mockResponse = {
      body: { getReader: () => mockReader },
    } as unknown as Response;

    await expect(collect(mockResponse)).rejects.toThrow('network failure');
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it('handles an empty stream (no data before done)', async () => {
    const mockReader = {
      read: vi.fn().mockResolvedValueOnce({ done: true, value: undefined }),
      releaseLock: vi.fn(),
    };
    const mockResponse = {
      body: { getReader: () => mockReader },
    } as unknown as Response;

    const items = await collect(mockResponse);
    expect(items).toEqual([]);
  });

  it('handles a stream with only comments and empty lines', async () => {
    const items = await collect(
      makeResponse(': keepalive\n\n: another\n\n\n'),
    );
    expect(items).toEqual([]);
  });
});
