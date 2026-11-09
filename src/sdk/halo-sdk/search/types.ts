export interface CodeSearchOptions {
  backend: 'zvec-grep';
  nodePath: string;
  modulePath: string;
  cachePath: string;
  workerPath?: string;
  supervisorPath?: string;
  runAsNode?: boolean;
  idleTimeoutMs?: number;
  timeoutMs?: number;
}

export interface CodeSearchRequest {
  root: string;
  query: string;
  limit?: number;
  refresh?: boolean;
  readDenyRoots?: readonly string[];
  signal?: AbortSignal;
}

export interface CodeSearchHit {
  path: string;
  lineStart: number;
  lineEnd: number;
  snippet: string;
  truncated: boolean;
}

export interface CodeSearchResult {
  hits: CodeSearchHit[];
  freshness: 'fresh' | 'possibly_stale';
  exhaustive: false;
}

export interface CodeSearchDiagnostics {
  workers: number;
  pending: number;
  running: number;
}

export interface CodeSearchService {
  search(request: CodeSearchRequest): Promise<CodeSearchResult>;
  dispose(): Promise<void>;
}
