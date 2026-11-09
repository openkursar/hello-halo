import type { CodeSearchResult } from './types.js';

export interface WorkerConfiguration {
  workerPath: string;
  modulePath: string;
  root: string;
  indexPath: string;
  cachePath: string;
}

export type WorkerRequest =
  | { type: 'search'; id: number; query: string; limit: number; refresh: boolean }
  | { type: 'close'; force?: boolean };

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'result'; id: number; result: CodeSearchResult; rssBytes: number }
  | { type: 'error'; id?: number; message: string };
