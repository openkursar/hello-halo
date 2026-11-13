import { reserveTranscript } from '../utils/runtime-ownership.js';
import { nativeBinaryPath } from '../native/binding.js';
import { Worker, type ResourceLimits } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { getRootLogger, getLogger, type LogLevel } from '../utils/logger.js';
import { killProcessTree as killTree, type ProcessTreeContext } from '../utils/processes.js';
import type { Options } from '../types/config.js';
import type { ProviderConfig } from '../llm/provider.js';
import type { SDKMessage } from '../core/query-types.js';
import { RpcPeer, aborted } from './rpc.js';
import { HostCallbacks } from './callbacks.js';
import type { WorkerSetup } from './options.js';
import { RemoteSession, type WorkerSession } from './session.js';
import { fileLocks, transcriptLocks } from './locks.js';
import { WORKER_PROTOCOL_VERSION } from './protocol.js';
import { createSessionCodeSearchService } from '../core/code-search.js';
import type { CodeSearchService } from '../search/index.js';
import type { ReadSessionToolContextModeOptions, SessionToolContextMode } from '../core/session-tool-context.js';

export interface WorkerRuntimeOptions {
  /** Ready worker floor after explicit initialization. Default 1; 0 disables prewarming. */
  warmWorkers?: number;
  /** Optional host thread budget. Omitted or Infinity means no SDK worker-count ceiling. */
  maxWorkers?: number;
  /** Placement target, not an admission limit. Idle sessions carry a small weight. */
  targetActiveSessions?: number;
  idleTimeoutMs?: number;
  startupTimeoutMs?: number;
  /** Session preparation includes external MCP handshakes and has its own deadline. */
  sessionStartupTimeoutMs?: number;
  closeTimeoutMs?: number;
  /** Whole-runtime shutdown budget; ordinary session retirement keeps closeTimeoutMs. */
  shutdownTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  resourceLimits?: ResourceLimits;
  /** Optional Node module that constructs worker-local providers, tools or callback implementations. */
  setup?: WorkerSetup;
  /** Override the shipped entry location when a bundler or archive relocates it. */
  workerUrl?: URL;
}
export interface WorkerPlacement { group?: string; setup?: WorkerSetup }
/** Standard providers need only data; a setup module is reserved for custom implementations. */
export interface WorkerSessionOptions extends Options { providerConfig?: ProviderConfig }
export interface WorkerDiagnostics {
  closed: boolean;
  workers: Array<{ threadId: number; state: string; sessions: number; active: number; collaborators: number; pendingRpc: number; callbacks: number; children: number;
    pendingInputs: number; pendingInputBytes: number; bufferedEvents: number }>;
  fileLocks: number;
  transcriptLocks: number;
  recentFailures: number;
}
interface Resident {
  group?: string;
  callbacks: HostCallbacks;
  lifetime: AbortController;
  session?: RemoteSession;
  closing: boolean;
  cleanup?: Promise<void>;
  codeSearch?: CodeSearchService;
}
interface Slot {
  id: string;
  worker: Worker;
  peer: RpcPeer;
  state: 'starting' | 'ready' | 'closing' | 'failed';
  ready: Promise<void>;
  resolveReady(): void;
  rejectReady(error: Error): void;
  residents: Map<string, Resident>;
  locks: Map<string, { scope: string; release(): void }>;
  children: Map<string, { pid: number; context?: ProcessTreeContext }>;
  nativeChildren: number;
  active: number;
  collaborators: number;
  lastHeartbeat: number;
  idleSince: number;
  startupTimer: ReturnType<typeof setTimeout>;
  exited: Promise<void>;
}


function positive(value: number | undefined, fallback: number, name: string, zero = false): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < (zero ? 0 : 1)) throw new RangeError(`Invalid ${name}`);
  return result;
}

/** Reuses grouped Node workers within an optional host-owned thread budget. */
export class WorkerRuntime {
  private slots = new Set<Slot>();
  private initialized = false;
  private closed = false;
  private shutdown?: Promise<void>;
  private readonly shutdownController = new AbortController();
  private maintenance?: ReturnType<typeof setInterval>;
  private failures: number[] = [];
  private lastStateLog = 0;
  private lastMaintenance = Date.now();
  private retryAt = 0;
  private readonly config: Required<Omit<WorkerRuntimeOptions, 'resourceLimits' | 'setup' | 'workerUrl'>>;

  constructor(private readonly options: WorkerRuntimeOptions = {}) {
    const maxWorkers = options.maxWorkers ?? Infinity;
    if (maxWorkers !== Infinity && (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1)) throw new RangeError('Invalid maxWorkers');
    const warmWorkers = positive(options.warmWorkers, 1, 'warmWorkers', true);
    if (warmWorkers > maxWorkers) throw new RangeError('warmWorkers cannot exceed maxWorkers');
    this.config = {
      maxWorkers, warmWorkers,
      targetActiveSessions: positive(options.targetActiveSessions, 8, 'targetActiveSessions'),
      idleTimeoutMs: positive(options.idleTimeoutMs, 60_000, 'idleTimeoutMs'),
      startupTimeoutMs: positive(options.startupTimeoutMs, 30_000, 'startupTimeoutMs'),
      sessionStartupTimeoutMs: positive(options.sessionStartupTimeoutMs, 120_000, 'sessionStartupTimeoutMs'),
      closeTimeoutMs: positive(options.closeTimeoutMs, 30_000, 'closeTimeoutMs'),
      shutdownTimeoutMs: positive(options.shutdownTimeoutMs, options.closeTimeoutMs ?? 30_000, 'shutdownTimeoutMs'),
      heartbeatIntervalMs: positive(options.heartbeatIntervalMs, 1_000, 'heartbeatIntervalMs'),
      heartbeatTimeoutMs: positive(options.heartbeatTimeoutMs, 30_000, 'heartbeatTimeoutMs'),
    };
    if (this.config.heartbeatTimeoutMs <= this.config.heartbeatIntervalMs) throw new RangeError('heartbeatTimeoutMs must exceed heartbeatIntervalMs');
  }

  /** Concurrent callers share worker startup. Module import and construction start no threads. */
  async initialize(): Promise<void> {
    if (this.closed) throw new Error('Worker runtime is closed');
    if (!this.initialized) {
      this.initialized = true;
      this.maintenance = setInterval(() => this.maintain(), this.config.heartbeatIntervalMs);
      this.maintenance.unref();
    }
    if (!this.available().length && Date.now() < this.retryAt) {
      await delay(this.retryAt - Date.now(), undefined, { signal: this.shutdownController.signal });
      if (this.closed) throw new Error('Worker runtime is closed');
    }
    if (!this.available().length && this.slots.size >= this.config.maxWorkers) {
      await Promise.race([...this.slots].map(slot => slot.exited));
      if (this.closed) throw new Error('Worker runtime is closed');
    }
    const available = this.available();
    while (available.length < this.config.warmWorkers) available.push(this.startWorker());
    await Promise.all(available.slice(0, this.config.warmWorkers).map(slot => slot.ready));
  }

  async createSession(options: WorkerSessionOptions, placement: WorkerPlacement = {}): Promise<WorkerSession> {
    return this.create(options, placement);
  }

  /** Runs bounded history validation off the host thread without creating an agent session. */
  async readSessionToolContextMode(
    sessionId: string,
    options: ReadSessionToolContextModeOptions,
    controls: { signal?: AbortSignal; group?: string } = {},
  ): Promise<SessionToolContextMode> {
    controls.signal?.throwIfAborted();
    const payload = structuredClone({ sessionId, options });
    await this.initialize();
    if (this.closed) throw new Error('Worker runtime is closed');
    controls.signal?.throwIfAborted();
    const scope = randomUUID();
    const lifetime = new AbortController();
    const resident: Resident = { group: controls.group, callbacks: new HostCallbacks(lifetime.signal), lifetime, closing: false };
    let slot: Slot;
    try { slot = this.select(controls.group); }
    catch (error) { lifetime.abort(); resident.callbacks.clear(); throw error; }
    slot.residents.set(scope, resident);
    slot.worker.ref();
    const onAbort = () => { lifetime.abort(); void this.dispose(slot, scope).catch(error => this.fail(slot, error)); };
    controls.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await slot.ready;
      if (resident.closing || this.closed || controls.signal?.aborted) throw aborted();
      return await slot.peer.request<SessionToolContextMode>(scope, 'readSessionToolContextMode', payload,
        { signal: lifetime.signal, timeoutMs: this.config.sessionStartupTimeoutMs });
    } finally {
      controls.signal?.removeEventListener('abort', onAbort);
      await this.dispose(slot, scope).catch(error => this.fail(slot, error));
    }
  }

  /** One-shot queries execute the SDK's original query implementation inside a worker. */
  async *query(params: { prompt: string; options?: WorkerSessionOptions }, placement: WorkerPlacement = {}): AsyncGenerator<SDKMessage, void, undefined> {
    const session = await this.create(params.options ?? {}, placement, params.prompt);
    try { yield* session.stream(); }
    finally { await session[Symbol.asyncDispose](); }
  }

  private async create(options: WorkerSessionOptions, placement: WorkerPlacement, prompt?: string): Promise<WorkerSession> {
    if (options.abortController?.signal.aborted) throw aborted();
    await this.initialize();
    if (this.closed) throw new Error('Worker runtime is closed');
    const scope = randomUUID();
    const lifetime = new AbortController();
    const resident: Resident = { group: placement.group, callbacks: new HostCallbacks(lifetime.signal), lifetime, closing: false };
    let encoded: ReturnType<HostCallbacks['encode']>;
    let slot: Slot;
    try {
      resident.codeSearch = createSessionCodeSearchService(options);
      encoded = resident.callbacks.encode(options, resident.codeSearch);
      slot = this.select(placement.group);
    } catch (error) {
      lifetime.abort(); resident.callbacks.clear();
      await resident.codeSearch?.dispose();
      throw error;
    }
    slot.residents.set(scope, resident);
    slot.worker.ref();
    const onAbort = () => {
      if (resident.session) resident.session.close();
      else void this.dispose(slot, scope).catch(error => this.fail(slot, error));
    };
    options.abortController?.signal.addEventListener('abort', onAbort, { once: true });
    try {
      await slot.ready;
      if (resident.closing || this.closed || options.abortController?.signal.aborted) throw aborted();
      const result = await slot.peer.request<{ sessionId: string }>(scope, 'create', {
        encoded, setup: placement.setup ?? this.options.setup, prompt,
      }, { signal: options.abortController?.signal, timeoutMs: this.config.sessionStartupTimeoutMs });
      if (resident.closing || this.closed) throw aborted();
      resident.session = new RemoteSession(scope, result.sessionId, slot.worker.threadId, slot.peer,
        async () => {
          options.abortController?.signal.removeEventListener('abort', onAbort);
          await this.dispose(slot, scope);
        }, error => this.fail(slot, error));
      return resident.session;
    } catch (error) {
      options.abortController?.signal.removeEventListener('abort', onAbort);
      await this.dispose(slot, scope).catch(failure => this.fail(slot, failure));
      throw error;
    }
  }

  private available(): Slot[] { return [...this.slots].filter(slot => slot.state === 'ready' || slot.state === 'starting'); }

  private select(group?: string): Slot {
    const slots = this.available();
    const weight = (slot: Slot) => Math.max(slot.active, [...slot.residents.values()].filter(item => !item.session || item.session.hasPendingInput()).length)
      + slot.collaborators + slot.residents.size / 8;
    const preferred = group ? slots.filter(slot => [...slot.residents.values()].some(item => item.group === group)) : [];
    preferred.sort((a, b) => weight(a) - weight(b));
    if (preferred[0] && weight(preferred[0]) < this.config.targetActiveSessions) return preferred[0];
    slots.sort((a, b) => weight(a) - weight(b));
    if (slots[0] && (weight(slots[0]) < this.config.targetActiveSessions || this.slots.size >= this.config.maxWorkers)) return slots[0];
    return this.startWorker();
  }

  private logLevel(): LogLevel {
    const logger = getRootLogger();
    return (['debug', 'info', 'warn', 'error'] as const).find(level => logger.isLevelEnabled(level)) ?? 'silent';
  }

  private startWorker(): Slot {
    this.failures = this.failures.filter(time => Date.now() - time < 60_000);
    if (this.failures.length >= 3) throw new Error('Worker restart circuit is open; retry after one minute');
    if (this.closed || this.slots.size >= this.config.maxWorkers) throw new Error('Worker runtime has no available thread slot');
    const worker = new Worker(this.options.workerUrl ?? getWorkerEntryUrl(), {
      execArgv: [], resourceLimits: this.options.resourceLimits,
      workerData: {
        haloSdkNativeLibraryPath: nativeBinaryPath(),
        protocolVersion: WORKER_PROTOCOL_VERSION, logLevel: this.logLevel(), heartbeatIntervalMs: this.config.heartbeatIntervalMs,
        cleanupHookTimeoutMs: Math.max(1, Math.floor(this.config.closeTimeoutMs / 2)),
      },
    });
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    void ready.catch(() => {});
    const peer = new RpcPeer(frame => worker.postMessage(frame));
    let resolveExit!: () => void;
    const exited = new Promise<void>(resolve => { resolveExit = resolve; });
    const slot: Slot = {
      id: randomUUID(), worker, peer, state: 'starting', ready, resolveReady, rejectReady,
      residents: new Map(), locks: new Map(), children: new Map(), nativeChildren: 0, active: 0, collaborators: 0,
      lastHeartbeat: Date.now(), idleSince: Date.now(), exited,
      startupTimer: setTimeout(() => this.fail(slot, new Error('Worker initialization timed out')), this.config.startupTimeoutMs),
    };
    this.slots.add(slot);
    peer.onRequest = async (method, value, scope, signal) => {
      const resident = slot.residents.get(scope);
      if (!resident) throw new Error('Worker session callback has no owner');
      if (method === 'callback') return resident.callbacks.call(value.id, value.args, signal);
      if (method === 'lock' || method === 'lease') {
        const owner = `${slot.id}:${scope}`;
        const key = process.platform === 'win32' || process.platform === 'darwin' ? value.key.toLowerCase() : value.key;
        const reservation = method === 'lease' ? reserveTranscript(owner, key, value.sessionId, () => resident.closing) : undefined;
        const keys = reservation?.keys ?? [key];
        const lockId = value.lockId as string;
        const controller = new AbortController();
        const cancel = () => controller.abort();
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        slot.locks.set(lockId, { scope, release: cancel });
        const releases: Array<() => void> = [];
        const releaseAll = () => {
          reservation?.release();
          for (const release of releases.splice(0).reverse()) release();
        };
        try {
          for (const key of keys) {
            releases.push(await (method === 'lock' ? fileLocks : transcriptLocks).acquire(key, slot.id, controller.signal));
            if (controller.signal.aborted) throw aborted();
          }
          slot.locks.set(lockId, { scope, release: releaseAll });
          return lockId;
        } catch (error) { releaseAll(); slot.locks.delete(lockId); throw error; }
        finally { signal.removeEventListener('abort', cancel); }
      }
      throw new Error('Unknown worker callback');
    };
    peer.onEvent = (event, value) => {
      if (event === 'ready') {
        if (slot.state !== 'starting') return;
        if (value.protocolVersion !== WORKER_PROTOCOL_VERSION) { this.fail(slot, new Error('SDK worker protocol version mismatch')); return; }
        slot.state = 'ready'; clearTimeout(slot.startupTimer); slot.lastHeartbeat = Date.now(); slot.resolveReady();
        if (!slot.residents.size) worker.unref();
        getLogger('Worker').info('Worker ready', { threadId: worker.threadId });
      } else if (event === 'heartbeat') {
        slot.lastHeartbeat = Date.now(); slot.active = value.active; slot.collaborators = value.collaborators;
        slot.nativeChildren = value.nativeChildren ?? slot.nativeChildren;
      } else if (event === 'stream') slot.residents.get(value.scope)?.session?.acceptBatch(value);
      else if (event === 'consumed' || event === 'withdrawn') slot.residents.get(value.scope)?.session?.receipt(value.id, event === 'withdrawn');
      else if (event === 'unlock') { slot.locks.get(value.lockId)?.release(); slot.locks.delete(value.lockId); }
      else if (event === 'child') slot.children.set(value.id, { pid: value.pid, context: value.context });
      else if (event === 'childExit') slot.children.delete(value.id);
      else if (event === 'nativeChildren') slot.nativeChildren = value.count;
      else if (event === 'log') {
        const logger = getRootLogger().child(value.component || 'Worker');
        const level = value.level as 'debug' | 'info' | 'warn' | 'error';
        if (['debug', 'info', 'warn', 'error'].includes(level) && logger.isLevelEnabled(level)) logger[level](value.message, value.fields);
      }
    };
    worker.on('message', frame => {
      try { peer.receive(frame); } catch (error) { this.fail(slot, error instanceof Error ? error : new Error(String(error))); }
    });
    worker.on('messageerror', error => this.fail(slot, error));
    worker.on('error', error => this.fail(slot, error));
    worker.on('exit', code => {
      if (slot.state !== 'closing' && slot.state !== 'failed') this.fail(slot, new Error(`SDK worker exited unexpectedly (${code})`));
      clearTimeout(slot.startupTimer);
      slot.rejectReady(new Error('SDK worker closed before initialization completed'));
      peer.close(new Error('SDK worker exited'));
      const cleanup = Promise.all([
        ...[...slot.children.values()].map(child => killTree(child.pid, 'SIGKILL', child.context)),
        ...[...slot.residents.values()].map(resident => resident.codeSearch?.dispose()),
      ]);
      slot.children.clear();
      slot.nativeChildren = 0;
      for (const lock of slot.locks.values()) lock.release();
      slot.locks.clear();
      fileLocks.releaseOwner(slot.id); transcriptLocks.releaseOwner(slot.id);
      void cleanup.catch(error => getLogger('Worker').error('Worker exit resource cleanup failed', { error: String(error) }))
        .finally(() => { this.slots.delete(slot); resolveExit(); });
    });
    return slot;
  }

  private dispose(slot: Slot, scope: string): Promise<void> {
    const resident = slot.residents.get(scope);
    if (!resident) return Promise.resolve();
    if (resident.cleanup) return resident.cleanup;
    resident.closing = true;
    resident.cleanup = (async () => {
      try {
        if (slot.state === 'failed') await slot.exited;
        else {
          await slot.ready;
          slot.peer.cancelScope(scope);
          await slot.peer.request(`close:${scope}`, 'close', { scope }, { timeoutMs: this.config.closeTimeoutMs });
        }
        for (const [id, lock] of slot.locks) {
          if (lock.scope === scope) { lock.release(); slot.locks.delete(id); }
        }
      } finally {
        resident.lifetime.abort(); resident.callbacks.clear();
        try { await resident.codeSearch?.dispose(); }
        finally {
          slot.residents.delete(scope);
          if (!slot.residents.size) { slot.idleSince = Date.now(); slot.worker.unref(); }
        }
      }
    })();
    return resident.cleanup;
  }

  private fail(slot: Slot, error: Error): void {
    if (slot.state === 'failed' || slot.state === 'closing') return;
    slot.state = 'failed'; this.failures.push(Date.now()); clearTimeout(slot.startupTimer);
    this.retryAt = Date.now() + Math.min(30_000, 250 * 2 ** Math.min(7, this.failures.length - 1));
    getLogger('Worker').error('Worker retired after failure', { threadId: slot.worker.threadId, sessions: slot.residents.size, error });
    slot.rejectReady(error); slot.peer.close(error);
    for (const resident of slot.residents.values()) {
      resident.lifetime.abort(); resident.session?.fail(error);
      void resident.codeSearch?.dispose().catch(failure => getLogger('Worker').error('Search cleanup after worker failure failed', { error: String(failure) }));
    }
    void slot.worker.terminate().catch(failure => getLogger('Worker').error('Worker termination failed', { error: failure }));
  }

  private maintain(): void {
    const now = Date.now();
    const monitorPaused = now - this.lastMaintenance > this.config.heartbeatTimeoutMs / 2;
    this.lastMaintenance = now;
    for (const slot of this.slots) {
      if (slot.state !== 'ready') continue;
      if (monitorPaused) slot.lastHeartbeat = now;
      if (now - slot.lastHeartbeat > this.config.heartbeatTimeoutMs) { this.fail(slot, new Error('SDK worker heartbeat timed out')); continue; }
      slot.peer.notify('logLevel', this.logLevel());
      if (!slot.residents.size && this.available().length > this.config.warmWorkers && now - slot.idleSince >= this.config.idleTimeoutMs) {
        slot.state = 'closing';
        void slot.worker.terminate().catch(error => getLogger('Worker').error('Idle worker termination failed', { error }));
      }
    }
    if (this.slots.size && now - this.lastStateLog >= 60_000) {
      this.lastStateLog = now;
      getLogger('Worker').info('Runtime state', this.diagnostics() as unknown as Record<string, unknown>);
    }
  }

  diagnostics(): WorkerDiagnostics {
    return {
      closed: this.closed, workers: [...this.slots].map(slot => ({
        threadId: slot.worker.threadId, state: slot.state, sessions: slot.residents.size,
        active: slot.active, collaborators: slot.collaborators, pendingRpc: slot.peer.pendingCount,
        callbacks: slot.peer.incomingCount, children: slot.children.size + slot.nativeChildren,
        ...[...slot.residents.values()].reduce((total, resident) => {
          const state = resident.session?.diagnostics();
          if (state) { total.pendingInputs += state.pendingInputs; total.pendingInputBytes += state.pendingInputBytes; total.bufferedEvents += state.bufferedEvents; }
          return total;
        }, { pendingInputs: 0, pendingInputBytes: 0, bufferedEvents: 0 }),
      })), fileLocks: fileLocks.size, transcriptLocks: transcriptLocks.size,
      recentFailures: this.failures.filter(time => Date.now() - time < 60_000).length,
    };
  }

  close(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closed = true; this.shutdownController.abort(); clearInterval(this.maintenance);
    const cleanupDeadline = setTimeout(() => {
      getLogger('Worker').warn('Runtime shutdown grace expired; cancelling end hooks', { workers: this.slots.size });
      for (const slot of this.slots) for (const scope of slot.residents.keys()) slot.peer.notify('abortCleanup', { scope });
    }, Math.max(1, Math.floor(this.config.shutdownTimeoutMs / 2)));
    const shutdownDeadline = setTimeout(() => {
      for (const slot of this.slots) this.fail(slot, new Error('SDK runtime shutdown timed out'));
    }, this.config.shutdownTimeoutMs);
    this.shutdown = (async () => {
      const slots = [...this.slots];
      await Promise.all(slots.map(async slot => {
        await Promise.all([...slot.residents].map(async ([scope, resident]) => {
          resident.session?.close();
          await this.dispose(slot, scope).catch(error => this.fail(slot, error));
        }));
        if (slot.state !== 'failed') slot.state = 'closing';
        await slot.worker.terminate();
        await slot.exited;
      }));
    })().finally(() => { clearTimeout(cleanupDeadline); clearTimeout(shutdownDeadline); });
    return this.shutdown;
  }

  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }
}

export function createWorkerRuntime(options?: WorkerRuntimeOptions): WorkerRuntime { return new WorkerRuntime(options); }

export function getWorkerEntryUrl(): URL { return new URL('./entry.js', import.meta.url); }
