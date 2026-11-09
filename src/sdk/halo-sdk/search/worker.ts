import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WorkerConfiguration, WorkerRequest, WorkerResponse } from './protocol.js';
import type { CodeSearchHit } from './types.js';

interface IndexedItem {
  file: { absolutePath: string };
  range: { kind: string; startLine?: number; endLine?: number };
  content: string;
  status: string;
}
interface ZgEngine {
  index(options: Record<string, unknown>): Promise<unknown>;
  context(options: Record<string, unknown>): Promise<{ items: IndexedItem[] }>;
  close(): Promise<void>;
}

const configuration = JSON.parse(process.argv[2]) as WorkerConfiguration;
let engine: ZgEngine | undefined;
let indexed = false;
let busy = false;

function send(message: WorkerResponse): void {
  if (process.connected) process.send?.(message);
}

async function openEngine(): Promise<ZgEngine> {
  if (engine) return engine;
  if (Number(process.versions.node.split('.')[0]) < 22) {
    throw new Error('The optional code search backend requires a Node 22 or newer executable.');
  }
  await mkdir(configuration.indexPath, { recursive: true });
  const backend = await import(pathToFileURL(configuration.modulePath).href);
  if (typeof backend.createZvecGrep !== 'function') throw new Error('The configured module does not expose createZvecGrep.');
  engine = await backend.createZvecGrep({
    root: configuration.indexPath,
    home: join(configuration.cachePath, 'home'),
    modelCacheDir: join(configuration.cachePath, 'models'),
    embedding: 'local/potion-code-16m-v2',
    device: 'cpu',
    embeddingConcurrency: 1,
  }) as ZgEngine;
  return engine;
}

async function search(request: Extract<WorkerRequest, { type: 'search' }>): Promise<void> {
  const service = await openEngine();
  const refreshed = !indexed || request.refresh;
  if (refreshed) {
    await service.index({
      rootPaths: [{ absolutePath: configuration.root, recursive: true, follow: false }],
      resetPaths: true,
      follow: false,
      hidden: false,
      noIgnore: false,
      maxFileSizeBytes: 1024 * 1024,
    });
    indexed = true;
  }
  const result = await service.context({ query: request.query, limit: request.limit, autoUpdate: false, follow: false });
  if (!Array.isArray(result.items)) throw new Error('The search backend returned an invalid candidate list.');
  let fresh = refreshed;
  const hits: CodeSearchHit[] = [];
  for (const item of result.items.slice(0, request.limit)) {
    if (item.range?.kind !== 'text') throw new Error('The search backend returned a non-text candidate.');
    const start = item.range.startLine;
    const end = item.range.endLine;
    if (typeof item.file?.absolutePath !== 'string' || typeof item.content !== 'string' ||
        !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start! < 1 || end! < start!) {
      throw new Error('The search backend returned an invalid source location.');
    }
    fresh &&= item.status === 'fresh';
    hits.push({ path: item.file.absolutePath, lineStart: start!, lineEnd: end!,
      snippet: item.content.slice(0, 2000), truncated: item.content.length > 2000 });
  }
  send({ type: 'result', id: request.id, result: {
    hits, freshness: fresh ? 'fresh' : 'possibly_stale', exhaustive: false,
  }, rssBytes: process.memoryUsage().rss });
}

process.on('message', (message: WorkerRequest) => {
  if (message?.type === 'close') {
    void (engine?.close() ?? Promise.resolve()).catch(() => {
      send({ type: 'error', message: 'The search engine could not close cleanly.' });
    }).finally(() => process.disconnect());
    return;
  }
  if (message?.type !== 'search' || busy) {
    send({ type: 'error', message: 'The search worker received an invalid or overlapping request.' });
    return;
  }
  busy = true;
  void search(message).catch((error: unknown) => {
    send({ type: 'error', id: message.id, message: error instanceof Error ? error.message.slice(0, 500) : 'Code search failed.' });
  }).finally(() => { busy = false; });
});
process.on('disconnect', () => process.exit(0));
send({ type: 'ready' });
