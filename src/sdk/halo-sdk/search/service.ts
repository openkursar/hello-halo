import { createHash } from 'node:crypto';
import { setMaxListeners } from 'node:events';
import { realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { spawn, killProcessTree } from '../utils/processes.js';
import { realPath } from '../utils/read-deny.js';
import { getLogger } from '../utils/logger.js';
import type { WorkerConfiguration, WorkerRequest, WorkerResponse } from './protocol.js';
import type { CodeSearchDiagnostics, CodeSearchOptions, CodeSearchRequest, CodeSearchResult, CodeSearchService } from './types.js';

const MAX_WORKERS = 1;
const MAX_PENDING = 32;
const entries = new Map<string, Entry>();
let heartbeat: ReturnType<typeof setInterval> | undefined;
let nextRequest = 0;

type Settings = Required<CodeSearchOptions>;
interface Job {
  request: CodeSearchRequest;
  signal: AbortSignal;
  timeoutMs: number;
  resolve(result: CodeSearchResult): void;
  reject(error: unknown): void;
  removeListener(): void;
}
interface Entry {
  key: string;
  root: string;
  settings: Settings;
  owners: Map<symbol, Set<Entry>>;
  child?: ChildProcess;
  closing?: Promise<void>;
  jobs: Job[];
  active?: Job;
  retired: boolean;
  idle?: ReturnType<typeof setTimeout>;
}

class SearchError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function within(target: string, root: string): boolean {
  const insensitive = process.platform === 'win32' || process.platform === 'darwin';
  const relative = path.relative(insensitive ? root.toLowerCase() : root, insensitive ? target.toLowerCase() : target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new SearchError('cancelled', 'Code search was cancelled.');
}
function waitWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new SearchError('cancelled', 'Code search was cancelled.'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new SearchError('cancelled', 'Code search was cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function settingsFor(options: CodeSearchOptions): Settings {
  if (options.backend !== 'zvec-grep') throw new SearchError('configuration', 'Unsupported code search backend.');
  for (const field of ['nodePath', 'modulePath', 'cachePath'] as const) {
    if (!options[field] || !path.isAbsolute(options[field])) throw new SearchError('configuration', `Code search ${field} must be an absolute path.`);
  }
  for (const field of ['workerPath', 'supervisorPath'] as const) {
    if (options[field] && !path.isAbsolute(options[field]!)) throw new SearchError('configuration', `Code search ${field} must be absolute.`);
  }
  const idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (![idleTimeoutMs, timeoutMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 900_000)) {
    throw new SearchError('configuration', 'Code search timeouts must be positive milliseconds, at most 900000.');
  }
  return {
    backend: 'zvec-grep', nodePath: options.nodePath, modulePath: options.modulePath, cachePath: options.cachePath,
    idleTimeoutMs, timeoutMs, runAsNode: options.runAsNode ?? false,
    workerPath: options.workerPath ?? fileURLToPath(new URL('./worker.js', import.meta.url)),
    supervisorPath: options.supervisorPath ?? fileURLToPath(new URL('./supervisor.js', import.meta.url)),
  };
}
function pending(entry: Entry): number { return entry.jobs.length + (entry.active ? 1 : 0); }
export function getCodeSearchDiagnostics(): CodeSearchDiagnostics {
  return {
    workers: [...entries.values()].filter(entry => entry.child).length,
    pending: [...entries.values()].reduce((sum, entry) => sum + pending(entry), 0),
    running: [...entries.values()].filter(entry => entry.active).length,
  };
}
function updateHeartbeat(): void {
  if (entries.size && !heartbeat) {
    heartbeat = setInterval(() => getLogger('CodeSearch').info('Search worker state', { ...getCodeSearchDiagnostics() }), 300_000);
    heartbeat.unref();
  } else if (!entries.size && heartbeat) { clearInterval(heartbeat); heartbeat = undefined; }
}

async function stopWorker(entry: Entry, force = false): Promise<void> {
  if (entry.closing) return entry.closing;
  const child = entry.child;
  if (!child) return;
  const closing = new Promise<void>((resolve) => {
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (escalation) clearTimeout(escalation);
      if (entry.child === child) entry.child = undefined;
      resolve();
    };
    child.once('close', done);
    if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
    if (child.connected) child.send({ type: 'close', force } satisfies WorkerRequest, () => {});
    // The supervisor owns the process group; this also catches a stuck supervisor.
    escalation = setTimeout(() => {
      getLogger('CodeSearch').warn('Search supervisor shutdown exceeded its grace period', { pid: child.pid });
      if (child.pid) void killProcessTree(child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    }, 1500);
    escalation.unref();
  });
  entry.closing = closing;
  await closing;
  if (entry.closing === closing) entry.closing = undefined;
}
async function retire(entry: Entry): Promise<void> {
  entry.retired = true;
  if (entry.idle) clearTimeout(entry.idle);
  for (const job of entry.jobs.splice(0)) {
    job.removeListener();
    job.reject(new SearchError('disposed', 'The code search resource has been released.'));
  }
  await stopWorker(entry);
  if (entries.get(entry.key) === entry) entries.delete(entry.key);
  for (const owned of entry.owners.values()) owned.delete(entry);
  entry.owners.clear();
  updateHeartbeat();
}
function scheduleIdle(entry: Entry): void {
  if (!pending(entry) && !entry.retired) {
    if (entry.idle) clearTimeout(entry.idle);
    entry.idle = setTimeout(() => { void retire(entry); }, entry.settings.idleTimeoutMs);
    entry.idle.unref();
  }
}

function pump(entry: Entry): void {
  if (entry.active || entry.retired) return;
  const job = entry.jobs.shift();
  if (!job) { scheduleIdle(entry); return; }
  entry.active = job;
  void execute(entry, job.request, job.signal, job.timeoutMs)
    .then(result => verifyResult(result, entry.root, (job.request.readDenyRoots ?? []).map(realPath), job.request.limit ?? 5))
    .then(job.resolve, job.reject)
    .finally(() => {
      job.removeListener();
      entry.active = undefined;
      pump(entry);
    });
}
function enqueue(entry: Entry, request: CodeSearchRequest, signal: AbortSignal, timeoutMs: number): Promise<CodeSearchResult> {
  return new Promise((resolve, reject) => {
    const job: Job = { request, signal, timeoutMs, resolve, reject, removeListener: () => signal.removeEventListener('abort', abort) };
    const abort = () => {
      const queued = entry.jobs.indexOf(job);
      if (queued >= 0) {
        entry.jobs.splice(queued, 1);
        job.removeListener();
        scheduleIdle(entry);
      } else if (entry.active === job) {
        void stopWorker(entry, true);
      }
      reject(new SearchError('cancelled', 'Code search was cancelled.'));
    };
    signal.addEventListener('abort', abort, { once: true });
    entry.jobs.push(job);
    pump(entry);
  });
}
async function admit(settings: Settings, root: string, owner: symbol, owned: Set<Entry>, request: CodeSearchRequest, signal: AbortSignal): Promise<CodeSearchResult> {
  const key = JSON.stringify([settings.nodePath, settings.modulePath, settings.cachePath, settings.workerPath, settings.supervisorPath, settings.runAsNode, root]);
  for (;;) {
    checkSignal(signal);
    let entry = entries.get(key);
    if (entry?.retired) { await waitWithSignal(retire(entry), signal); continue; }
    if (!entry) {
      if (entries.size >= MAX_WORKERS) {
        const idle = [...entries.values()].find(candidate => pending(candidate) === 0);
        if (!idle) throw new SearchError('capacity', 'Code search workers are busy. Use Grep or try again after another search finishes.');
        await waitWithSignal(retire(idle), signal);
        continue;
      }
      entry = { key, root, settings, owners: new Map(), jobs: [], retired: false };
      entries.set(key, entry);
      updateHeartbeat();
    }
    if (pending(entry) >= MAX_PENDING) throw new SearchError('capacity', 'Too many code searches are waiting for this workspace.');
    if (entry.idle) clearTimeout(entry.idle);
    entry.owners.set(owner, owned);
    owned.add(entry);
    // Reserve the job before yielding so another workspace cannot evict this entry.
    return enqueue(entry, request, signal, settings.timeoutMs);
  }
}

function waitForMessage(child: ChildProcess, accept: (message: WorkerResponse) => boolean): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { child.off('message', message); child.off('error', error); child.off('exit', exit); };
    const message = (value: unknown) => {
      const response = value as WorkerResponse;
      if (!response || typeof response !== 'object') return;
      if (response.type === 'error') { cleanup(); reject(new SearchError('backend', response.message)); }
      else if (accept(response)) { cleanup(); resolve(response); }
    };
    const error = () => { cleanup(); reject(new SearchError('launch', 'Unable to start the configured code search executable.')); };
    const exit = (code: number | null, signal: NodeJS.Signals | null) => { cleanup(); reject(new SearchError('exit', `The code search worker exited before completing its request (${signal ?? code ?? 'unknown'}).`)); };
    child.on('message', message); child.once('error', error); child.once('exit', exit);
  });
}
async function worker(entry: Entry, signal: AbortSignal, expired: () => boolean): Promise<ChildProcess> {
  if (entry.closing) await entry.closing;
  checkSignal(signal);
  if (expired()) throw new SearchError('timeout', 'Code search exceeded its time limit.');
  if (entry.child) return entry.child;
  const { settings } = entry;
  const indexName = createHash('sha256').update(`halo-code-search-v1\0${entry.root}\0${settings.modulePath}`).digest('hex');
  const configuration: WorkerConfiguration = {
    workerPath: settings.workerPath, modulePath: settings.modulePath, root: entry.root, cachePath: settings.cachePath,
    indexPath: path.join(settings.cachePath, 'workspaces', indexName),
  };
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.HOME = path.join(settings.cachePath, 'home'); env.USERPROFILE = env.HOME;
  if (settings.runAsNode) env.ELECTRON_RUN_AS_NODE = '1';
  const child = spawn(settings.nodePath, [settings.supervisorPath, JSON.stringify(configuration)], {
    cwd: path.dirname(settings.modulePath), env, detached: process.platform !== 'win32', windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  entry.child = child;
  child.stderr?.resume();
  child.on('message', (message: unknown) => {
    const response = message as WorkerResponse;
    if (response?.type === 'error' && response.id === undefined && !entry.active) getLogger('CodeSearch').warn('Search worker cleanup failed', { pid: child.pid });
  });
  child.on('error', (error: NodeJS.ErrnoException) => {
    if (!entry.active) getLogger('CodeSearch').warn('Idle search worker process error', { pid: child.pid, code: error.code });
  });
  child.once('close', () => {
    if (entry.child === child) entry.child = undefined;
    getLogger('CodeSearch').info('Search worker stopped', { pid: child.pid });
  });
  await waitForMessage(child, message => message.type === 'ready');
  getLogger('CodeSearch').info('Search worker started', { pid: child.pid });
  return child;
}
async function execute(entry: Entry, request: CodeSearchRequest, signal: AbortSignal, timeoutMs: number): Promise<CodeSearchResult> {
  checkSignal(signal);
  if (entry.retired) throw new SearchError('disposed', 'The code search resource has been released.');
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; void stopWorker(entry, true); }, timeoutMs);
  timeout.unref();
  try {
    const child = await worker(entry, signal, () => timedOut);
    checkSignal(signal);
    const id = ++nextRequest;
    const reply = waitForMessage(child, message => message.type === 'result' && message.id === id);
    child.send({ type: 'search', id, query: request.query, limit: request.limit ?? 5, refresh: request.refresh ?? false } satisfies WorkerRequest,
      error => { if (error) void stopWorker(entry, true); });
    const response = await reply;
    if (response.type !== 'result') throw new SearchError('protocol', 'Unexpected code search response.');
    return response.result;
  } catch (error) {
    await stopWorker(entry, true);
    if (timedOut) throw new SearchError('timeout', 'Code search exceeded its time limit and was stopped.');
    checkSignal(signal);
    throw error;
  } finally { clearTimeout(timeout); }
}
async function verifyResult(result: CodeSearchResult, root: string, denied: readonly string[], limit: number): Promise<CodeSearchResult> {
  if (!result || !Array.isArray(result.hits) || result.hits.length > limit || result.exhaustive !== false ||
      !['fresh', 'possibly_stale'].includes(result.freshness)) throw new SearchError('protocol', 'Invalid code search response.');
  if (denied.some(deny => within(root, deny) || within(deny, root))) throw new SearchError('read_denied', 'Read restrictions changed during code search. Use Grep instead.');
  for (const hit of result.hits) {
    if (typeof hit.path !== 'string' || !path.isAbsolute(hit.path) || typeof hit.snippet !== 'string' || hit.snippet.length > 2000 ||
        !Number.isSafeInteger(hit.lineStart) || !Number.isSafeInteger(hit.lineEnd) || hit.lineStart < 1 || hit.lineEnd < hit.lineStart) throw new SearchError('protocol', 'Invalid code search candidate.');
    const actual = await realpath(hit.path).catch(() => undefined);
    if (!actual || !within(actual, root) || denied.some(deny => within(actual, deny)) || !(await stat(actual)).isFile()) {
      throw new SearchError('source_scope', 'A search candidate is unavailable or outside the permitted workspace. Refresh the index or use Grep.');
    }
    hit.path = actual;
  }
  return result;
}

export function createCodeSearchService(options: CodeSearchOptions): CodeSearchService {
  const settings = settingsFor(options);
  const owner = Symbol('code-search-owner'); const owned = new Set<Entry>(); const lifetime = new AbortController();
  setMaxListeners(0, lifetime.signal);
  return {
    async search(request) {
      const signal = new AbortController(); const forward = () => signal.abort();
      const sources = [lifetime.signal, ...(request.signal ? [request.signal] : [])];
      for (const source of sources) { source.addEventListener('abort', forward, { once: true }); if (source.aborted) forward(); }
      try {
        checkSignal(signal.signal);
        if (typeof request.query !== 'string' || !request.query.trim() || request.query.length > 2000 ||
            typeof request.root !== 'string' || !path.isAbsolute(request.root) ||
            (request.refresh !== undefined && typeof request.refresh !== 'boolean') || !Number.isInteger(request.limit ?? 5) ||
            (request.limit ?? 5) < 1 || (request.limit ?? 5) > 20) throw new SearchError('input', 'Provide a query of 1–2000 characters and a result limit of 1–20.');
        const root = await realpath(request.root);
        if (!(await stat(root)).isDirectory()) throw new SearchError('input', 'Code search requires a workspace directory.');
        const denied = (request.readDenyRoots ?? []).map(realPath);
        if (denied.some(deny => within(root, deny) || within(deny, root))) throw new SearchError('read_denied', 'CodeSearch cannot index this workspace while read restrictions overlap it. Use Grep for permission-aware exact searches.');
        if (within(realPath(settings.cachePath), root) || within(root, realPath(settings.cachePath))) throw new SearchError('configuration', 'The code search cache must be outside the indexed workspace.');
        checkSignal(signal.signal);
        const resolvedSettings = { ...settings, cachePath: realPath(settings.cachePath), modulePath: realPath(settings.modulePath),
          nodePath: realPath(settings.nodePath), workerPath: realPath(settings.workerPath), supervisorPath: realPath(settings.supervisorPath) };
        return await admit(resolvedSettings, root, owner, owned, request, signal.signal);
      } catch (error) {
        getLogger('CodeSearch').warn('Code search did not complete', { reason: error instanceof SearchError ? error.code : 'filesystem' });
        throw error;
      } finally { for (const source of sources) source.removeEventListener('abort', forward); }
    },
    async dispose() {
      lifetime.abort(); const released: Promise<void>[] = [];
      for (const entry of [...owned]) {
        owned.delete(entry); entry.owners.delete(owner);
        if (!entry.owners.size) released.push(retire(entry));
      }
      await Promise.all(released);
    },
  };
}
