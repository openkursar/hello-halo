/**
 * @module tools/file-read-state
 * Bounded read-before-write state shared by the file tools.
 * @license MIT
 */

import type { FileReadState } from '../types/tool.js';
import { hashFileContent } from './file-access.js';

const MAX_TRACKED_FILES = 512;
// UTF-16 upper bound: 512 entries retain at most 2 MiB of file text.
const MAX_CONTENT_BYTES = 4096;

export function setFileReadState(
  map: Map<string, FileReadState> | undefined,
  filePath: string,
  entry: FileReadState,
): void {
  if (!map) return;
  const contentHash = entry.contentHash ??
    (!entry.isPartialView && entry.content !== undefined ? hashFileContent(entry.content) : undefined);
  let content = entry.content;
  if (content !== undefined) {
    // A short slice can otherwise keep its much larger source string alive.
    content = content.length * 2 <= MAX_CONTENT_BYTES
      ? Buffer.from(content, 'utf16le').toString('utf16le')
      : undefined;
  }
  map.delete(filePath);
  while (map.size >= MAX_TRACKED_FILES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  map.set(filePath, { ...entry, content, contentHash });
}

export function isFileStateFresh(
  state: FileReadState,
  contentHash: string,
  timestamp: number,
  allowUnchangedContent: boolean,
): boolean {
  const expectedHash = state.contentHash ??
    (!state.isPartialView && state.content !== undefined ? hashFileContent(state.content) : undefined);
  if (expectedHash === undefined || contentHash !== expectedHash) return false;
  return timestamp === state.timestamp || (allowUnchangedContent && !state.isPartialView);
}
