import type { ProviderResponse, StreamEvent } from '../types/provider.js';
import type { ReadableStreamReadResult } from 'node:stream/web';
import { getLogger } from '../utils/logger.js';
import { loadBinding, nativeError, parseNativeValue, stringifyNativeValue } from './binding.js';

export function isQuirkyModel(model: string): boolean {
  return parseNativeValue(loadBinding().nativeValue('modelQuirks.isQuirky', stringifyNativeValue([model]))) as boolean;
}
export function applyModelQuirks(model: string, response: ProviderResponse): ProviderResponse {
  const receipt = parseNativeValue(loadBinding().nativeValue('modelQuirks.response', stringifyNativeValue([model, response]))) as {
    response: ProviderResponse; sources: (number | null)[]; copied: boolean[]; inputChanged: boolean[];
  };
  const content = receipt.response.content.map((block, index) => {
    const source = receipt.sources[index]; if (source === null) return block;
    const original = response.content[source]; if (!receipt.copied[index]) return original;
    const result = { ...original, ...block };
    if (!receipt.inputChanged[index] && result.type === 'tool_use' && original.type === 'tool_use') result.input = original.input;
    return result;
  });
  return { ...response, content, stopReason: receipt.response.stopReason };
}
export function applyStreamQuirks(_model: string, event: StreamEvent): StreamEvent { return event; }

export async function* parseSSEStream(response: Response, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>, void, undefined> {
  const reader = response.body?.getReader();
  if (!reader) throw nativeError(new Error(loadBinding().nativeValue('error.unreadableResponseBody', '[]')));
  const parser = new (loadBinding().NativeSseParser)();
  const decoder = new TextDecoder('utf-8');
  let completed = false, cancelled = false;
  const cancel = () => {
    if (cancelled || completed) return;
    cancelled = true;
    void reader.cancel().catch(error => getLogger('StreamParser').warn('SSE reader cancellation failed', { reason: error instanceof Error ? error.message : String(error) }));
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    let batch: { records: { value: Record<string, unknown>; event?: string }[]; done: boolean } = { records: [], done: false };
    while (true) {
      signal?.throwIfAborted();
      if (batch.records.length) {
        const record = batch.records[0];
        if (record.event !== undefined) record.value.__event = record.event;
        yield record.value;
        signal?.throwIfAborted();
        try { batch = parseNativeValue(parser.feed('')); } catch (error) { throw nativeError(error); }
        continue;
      }
      if (batch.done) return;
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); } catch (error) { completed = true; throw error; }
      signal?.throwIfAborted();
      if (chunk.done) { completed = true; return; }
      try { batch = parseNativeValue(parser.feed(decoder.decode(chunk.value, { stream: true }))); }
      catch (error) { throw nativeError(error); }
    }
  } finally { signal?.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
}
