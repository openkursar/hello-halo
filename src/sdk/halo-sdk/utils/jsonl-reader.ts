import { createReadStream } from 'node:fs';

export interface JsonlRecord {
  line: string;
  bytes: number;
  value?: Record<string, unknown>;
  start: number;
  end: number;
  terminated: boolean;
}

/** A bounded line reader; unlike readline, one missing newline cannot grow memory indefinitely. */
export async function* readJsonl(path: string, options: {
  start?: number;
  onOversized?: () => void;
  signal?: AbortSignal;
} = {}): AsyncGenerator<JsonlRecord> {
  const maxLineBytes = 32 * 1024 * 1024;
  let parts: Buffer[] = [];
  let bytes = 0;
  let oversized = false;
  let skipPartial = (options.start ?? 0) > 0;
  let position = options.start ?? 0;
  let recordStart = position;
  const record = (terminated: boolean): JsonlRecord | undefined => {
    if (skipPartial || bytes === 0) return undefined;
    if (oversized) {
      if (!options.onOversized) throw new RangeError('Transcript record exceeds the 32 MiB limit');
      options.onOversized();
      return undefined;
    }
    const line = Buffer.concat(parts, bytes).toString('utf8');
    let value: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed;
    } catch { /* The caller decides how to report or preserve malformed records. */ }
    return { line, bytes, value, start: recordStart, end: position, terminated };
  };
  const stream = createReadStream(path, { start: options.start ?? 0, highWaterMark: 64 * 1024, signal: options.signal });
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      let offset = 0;
      while (offset < buffer.length) {
        const newline = buffer.indexOf(10, offset);
        const end = newline < 0 ? buffer.length : newline;
        bytes += end - offset;
        position += end - offset + (newline < 0 ? 0 : 1);
        if (bytes > maxLineBytes) {
          if (!skipPartial && !options.onOversized) throw new RangeError('Transcript record exceeds the 32 MiB limit');
          oversized = true;
          parts = [];
        }
        else if (!oversized && end > offset) parts.push(buffer.subarray(offset, end));
        if (newline < 0) break;
        const next = record(true);
        if (next) yield next;
        parts = [];
        bytes = 0;
        oversized = false;
        skipPartial = false;
        recordStart = position;
        offset = newline + 1;
      }
    }
    const last = record(false);
    if (last) yield last;
  } finally { stream.destroy(); }
}
