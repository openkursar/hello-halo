import type { FileHandle } from 'node:fs/promises';

/** The extra byte detects growth without allowing an unbounded read allocation. */
export async function readBounded(handle: FileHandle, limit: number): Promise<Buffer> {
  const stat = await handle.stat();
  if (!stat.isFile()) throw new Error('Only regular files can be read');
  if (stat.size > limit) throw new Error(`File exceeds the ${limit} byte read limit. Use a streaming command to select a smaller portion.`);
  const buffer = Buffer.allocUnsafe(Math.min(stat.size + 1, limit + 1));
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) return buffer.subarray(0, offset);
    offset += bytesRead;
  }
  if (offset > stat.size) throw new Error('File grew while being read. Obtain a fresh, complete view before changing this file.');
  return buffer.subarray(0, offset);
}
