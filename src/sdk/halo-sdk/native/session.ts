import { randomUUID } from 'node:crypto';
import type { SDKSession, InputOptions, LiveInputOptions, SessionCloseOptions, SessionRuntimeStats } from '../core/session.js';
import type { SDKMessage } from '../core/query-types.js';
import type { Options, PermissionMode } from '../types/config.js';
import type { Goal, GoalInput } from '../types/goal.js';
import type { WorkerSessionQuery } from '../worker/session.js';
import { getLogger } from '../utils/logger.js';
import { loadBinding, nativeError, callbackError, routeNativeLog, type NativeHandle } from './binding.js';
import { registerProcessOwner } from './process-owner.js';
import { NativeCallbacks } from './callbacks.js';
import { inheritOptionCapabilities } from './options.js';
import { runPublic } from './operation.js';

interface QueuedEvent { event: SDKMessage | null; eventId?: string; bytes: number }

function wellFormedText(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function assertWellFormedInput(value: unknown, seen = new Set<object>()): void {
  if (typeof value === 'string') {
    if (!wellFormedText(value)) {
      throw new TypeError('Session input contains an unpaired UTF-16 surrogate, which the native journal cannot represent; send well-formed Unicode text');
    }
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertWellFormedInput(item, seen);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    assertWellFormedInput(key, seen);
    assertWellFormedInput(item, seen);
  }
}

export class NativeSdkSession implements SDKSession {
  readonly abortController: AbortController;
  readonly query: WorkerSessionQuery;
  private readonly handle: NativeHandle;
  private readonly oneShot: boolean;
  private readonly callbacks = new NativeCallbacks();
  private readonly inputs = new Map<string, LiveInputOptions | undefined>();
  private readonly listeners = new Set<(error?: Error) => void>();
  private readonly queue: QueuedEvent[] = [];
  private queueBytes = 0;
  private session = '';
  private failure?: Error;
  private retired = false;
  private activeStream?: AsyncGenerator<SDKMessage, void, undefined>;
  private streamRevision = 0;
  private ended = false;
  private wake?: () => void;
  private capacity?: () => void;
  private cleanup?: Promise<void>;
  private readonly cleanupSignals = new Map<AbortSignal, () => void>();
  private readonly ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readonly externalAbort: () => void;
  private readonly pumpFinished: Promise<void>;

  constructor(options: Options, ownership?: Parameters<NativeCallbacks['setOwnershipCoordinator']>[0], private readonly closeTimeoutMs?: number) {
    if (ownership) this.callbacks.setOwnershipCoordinator(ownership);
    this.oneShot = (options as Options & { nativeQuery?: boolean }).nativeQuery === true;
    this.abortController = options.abortController ?? new AbortController();
    this.externalAbort = () => this.close();
    this.ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    try { this.handle = new (loadBinding().NativeSession)(JSON.stringify(this.callbacks.encode(options)), this.callbacks.catalogReleaseCallback()); }
    catch (error) { void this.callbacks.close(); throw nativeError(error); }
    this.callbacks.attach(this.handle);
    const handle = this.handle;
    registerProcessOwner(this, { count: () => handle.ownedProcessCount(), async reap() {
      try { await handle.reapOwnedProcesses(); } catch (error) { throw nativeError(error); }
    } });
    const self = this;
    this.query = {
      transport: {
        isReady: () => !self.retired && !!self.session,
        get ready() { return !self.retired && !!self.session; },
        onExit: callback => { this.listeners.add(callback); return () => this.listeners.delete(callback); },
      },
      supportedCommands: () => this.command('supportedCommands'),
      supportedModels: () => this.command('supportedModels'),
      mcpServerStatus: () => this.command('mcpServerStatus'),
      reconnectMcpServer: async name => { await this.command('reconnectMcpServer', [name]); },
      toggleMcpServer: async (name, enabled) => { await this.command('toggleMcpServer', [name, enabled]); },
      setMcpServers: servers => this.command('setMcpServers', [servers]),
      stopTask: async id => { await this.command('stopTask', [id]); },
    };
    this.pumpFinished = this.pump();
    this.abortController.signal.addEventListener('abort', this.externalAbort, { once: true });
    if (this.abortController.signal.aborted) this.close();
  }

  get sessionId(): string { return this.session; }
  isClosing(): boolean { return this.retired; }
  async initialized(): Promise<this> { await this.ready; return this; }
  initializationError(): Error | undefined { return this.failure; }

  async command<T>(name: string, args: unknown[] = []): Promise<T> {
    if (this.retired && name !== 'getRuntimeStats') throw this.failure ?? new Error('Session is closed');
    try { return JSON.parse(await this.handle.command(name, JSON.stringify(args, function (_key, value) {
      return value === undefined && Array.isArray(this) ? { __haloSdkNativeUndefined: true } : value;
    }))) as T; }
    catch (error) { throw nativeError(error); }
  }

  private async pump(): Promise<void> {
    try {
      while (!this.ended) {
        const raw = await this.handle.next();
        if (raw === null) break;
        const envelope = JSON.parse(raw);
        if (envelope.kind === 'log') {
          routeNativeLog(envelope.record);
        } else if (envelope.kind === 'ready') {
          this.session = envelope.sessionId;
          this.readyResolve();
        } else if (envelope.kind === 'callback') {
          void this.invoke(envelope.id, envelope.method, envelope.params);
        } else if (envelope.kind === 'callbackCancelled') {
          this.callbacks.cancel(envelope.id);
        } else if (envelope.kind === 'inputConsumed') {
          this.receipt(envelope.id, false);
        } else if (envelope.kind === 'event' || envelope.kind === 'streamEnd') {
          if (this.retired) continue;
          while (!this.retired && (this.queue.length >= 256 || this.queueBytes >= 4 * 1024 * 1024)) {
            await new Promise<void>(resolve => { this.capacity = resolve; });
          }
          if (this.retired) continue;
          const bytes = raw.length * 2;
          this.queue.push({ event: envelope.kind === 'streamEnd' ? null : envelope.event, eventId: envelope.eventId, bytes });
          this.queueBytes += bytes;
          this.wake?.(); this.wake = undefined;
        } else if (envelope.kind === 'error') {
          if (!this.session && typeof envelope.sessionId === 'string') this.session = envelope.sessionId;
          throw nativeError(new Error(JSON.stringify(envelope)));
        } else if (envelope.kind === 'closed') break;
        else throw new Error(`Unknown native envelope kind: ${String(envelope.kind)}`);
      }
    } catch (error) {
      this.failure = nativeError(error);
      this.readyReject(this.failure);
      getLogger('Native').warn('Native session stream failed', { sessionId: this.session, error: String(this.failure) });
      this.close();
    } finally {
      this.callbacks.closeCatalogViews();
      this.handle.eventConsumed();
      this.ended = true;
      if (!this.session) this.readyReject(this.failure ?? new Error('Session closed during preparation'));
      this.wake?.(); this.wake = undefined;
      this.capacity?.(); this.capacity = undefined;
    }
  }

  private async invoke(id: string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.callbacks.call(id, method, params);
      this.handle.callbackResponse(id, JSON.stringify(result === undefined ? { __haloSdkNativeUndefined: true } : result));
    } catch (error) {
      try {
        this.handle.callbackResponse(id, 'null', callbackError(error));
      } catch (failure) {
        if (!this.retired) getLogger('Native').warn('Native callback response could not be delivered', { sessionId: this.session, method, error: String(failure) });
      }
    }
  }

  private receipt(id: string, withdrawn: boolean): void {
    const options = this.inputs.get(id);
    if (!this.inputs.has(id)) return;
    this.inputs.delete(id);
    try { if (withdrawn) options?.onWithdrawn?.(); else options?.onConsumed?.(); }
    catch (error) { getLogger('Native').warn('Input receipt handler failed', { sessionId: this.session, error: String(error) }); }
  }

  private accept(message: string | Record<string, unknown>, live: boolean, options?: LiveInputOptions): boolean {
    if (this.retired) return false;
    assertWellFormedInput(message);
    const id = randomUUID();
    this.inputs.set(id, options);
    try {
      const accepted = this.handle.send(JSON.stringify(message), id, live);
      if (!accepted) this.inputs.delete(id);
      return accepted;
    } catch (error) { this.inputs.delete(id); throw nativeError(error); }
  }

  async send(message: string | Record<string, unknown>, options?: InputOptions): Promise<void> {
    if (!this.accept(message, false, options)) throw this.failure ?? new Error('Session is closed');
  }

  sendIntoLiveTurn(message: string | Record<string, unknown>, options?: LiveInputOptions): boolean {
    try { return this.accept(message, true, options); }
    catch (error) {
      getLogger('Native').warn('Live input refused before acceptance', { sessionId: this.session, error: String(error) });
      return false;
    }
  }

  hasPendingInput(): boolean { return !this.retired && this.handle.hasPendingInput(); }
  getRuntimeStats(): Promise<SessionRuntimeStats> { return this.command('getRuntimeStats'); }

  async withdrawUnreadInput(): Promise<number> {
    if (this.retired) return 0;
    const ids = JSON.parse(this.handle.withdrawUnreadInput()) as string[];
    for (const id of ids) this.receipt(id, true);
    return ids.length;
  }

  async *stream(): AsyncGenerator<SDKMessage, void, undefined> {
    if (this.retired) throw this.failure ?? new Error('Session is closed');
    const revision = ++this.streamRevision;
    const previous = this.activeStream;
    if (previous) {
      await this.interrupt();
      await previous.return(undefined);
    }
    if (revision !== this.streamRevision) {
      getLogger('Native').warn('Session stream reader superseded before admission', { sessionId: this.session });
      return;
    }
    const current = this.consumeStream();
    this.activeStream = current;
    try { yield* current; }
    finally { if (this.activeStream === current) this.activeStream = undefined; }
  }

  private async *consumeStream(): AsyncGenerator<SDKMessage, void, undefined> {
    if (this.retired) throw this.failure ?? new Error('Session is closed');
    let completed = false;
    let boundarySeen = false;
    try {
      this.handle.startStream();
      while (true) {
        if (this.failure) throw this.failure;
        const queued = this.queue.shift();
        if (queued) {
          this.queueBytes -= queued.bytes;
          this.capacity?.(); this.capacity = undefined;
          if (queued.event === null) { completed = true; boundarySeen = true; return; }
          if (queued.event.type === 'result') completed = true;
          boundarySeen = queued.event.type === 'system' && queued.event.subtype === 'session_state_changed' && queued.event.state === 'idle';
          yield queued.event;
          if (queued.eventId) this.handle.eventConsumed(queued.eventId);
          if (boundarySeen || (completed && this.oneShot)) return;
        } else if (this.ended || this.retired) return;
        else await new Promise<void>(resolve => { this.wake = resolve; });
      }
    } finally {
      if (!completed && !boundarySeen && !this.retired) {
        await this.interrupt();
        await this.drainIdle();
      } else if (completed && !boundarySeen && !this.oneShot && !this.retired) await this.drainIdle();
    }
  }

  private async drainIdle(): Promise<void> {
    while (!this.ended && !this.retired) {
      const queued = this.queue.shift();
      if (queued) {
        this.queueBytes -= queued.bytes;
        this.capacity?.(); this.capacity = undefined;
        if (queued.eventId) this.handle.eventConsumed(queued.eventId);
        if (queued.event === null || (this.oneShot && queued.event.type === 'result')) return;
        if (queued.event.type === 'system' && queued.event.subtype === 'session_state_changed' && queued.event.state === 'idle') return;
      } else await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }

  async interrupt(): Promise<void> { this.callbacks.abort(); this.handle.interrupt(); }
  abortCleanup(): void { this.handle.abortCleanup(); }
  async setModel(model: string | undefined): Promise<void> { await this.command('setModel', [model]); }
  async setMaxThinkingTokens(value: number | null): Promise<void> { await this.command('setMaxThinkingTokens', [value]); }
  async setPermissionMode(mode: PermissionMode): Promise<void> { await this.command('setPermissionMode', [mode]); }
  getGoal(): Goal | null { try { return JSON.parse(this.handle.getGoal()); } catch (error) { throw nativeError(error); } }
  setGoal(goal: GoalInput | null): Goal | null {
    try { return JSON.parse(this.handle.setGoal(JSON.stringify(goal))); } catch (error) { throw nativeError(error); }
  }

  close(options?: SessionCloseOptions, timeoutMs = this.closeTimeoutMs): void {
    const cleanupSignal = options?.signal;
    if (cleanupSignal && !this.ended && !this.cleanupSignals.has(cleanupSignal)) {
      const abort = () => this.abortCleanup();
      this.cleanupSignals.set(cleanupSignal, abort);
      cleanupSignal.addEventListener('abort', abort, { once: true });
      if (cleanupSignal.aborted) abort();
    }
    if (this.cleanup || this.retired) return;
    this.retired = true;
    this.abortController.signal.removeEventListener('abort', this.externalAbort);
    this.abortController.abort();
    this.callbacks.abort();
    this.handle.close();
    this.queue.length = 0; this.queueBytes = 0; this.inputs.clear();
    this.capacity?.(); this.capacity = undefined;
    this.wake?.(); this.wake = undefined;
    const abortCleanup = () => this.abortCleanup();
    let hookDeadline: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const closing = this.handle.waitClosed().then(async () => {
      await this.pumpFinished;
      await this.callbacks.close();
    });
    const bounded = timeoutMs === undefined ? closing : Promise.race([closing, new Promise<never>((_resolve, reject) => {
      hookDeadline = setTimeout(abortCleanup, Math.max(1, Math.floor(timeoutMs / 2)));
      deadline = setTimeout(() => {
        this.failure ??= new Error('Native session cleanup timed out');
        reject(this.failure);
      }, timeoutMs);
    })]);
    this.cleanup = bounded.finally(() => {
      clearTimeout(hookDeadline); clearTimeout(deadline);
      for (const [signal, abort] of this.cleanupSignals) signal.removeEventListener('abort', abort);
      this.cleanupSignals.clear();
      for (const listener of this.listeners) {
        try { listener(this.failure); }
        catch (error) { getLogger('Native').warn('Session exit handler failed', { sessionId: this.session, error: String(error) }); }
      }
      this.listeners.clear();
    });
    void this.cleanup.catch(error => getLogger('Native').error('Native session cleanup failed', { sessionId: this.session, error: String(error) }));
  }

  async flush(): Promise<void> {
    try { await (this.cleanup ?? this.handle.flush()); } catch (error) { throw nativeError(error); }
  }
  async [Symbol.asyncDispose](): Promise<void> { this.close(); await this.flush(); }
}

export async function createSession(options: Options): Promise<SDKSession> {
  const prepared = options.continue ? await prepareSessionContinuation(options) : options;
  return new NativeSdkSession(prepared).initialized();
}

export async function prepareSessionContinuation(options: Options, signal: AbortSignal | undefined = options.abortController?.signal): Promise<Options> {
  if (!options.continue || options.resume || (options as Options & { nativeQuery?: boolean }).nativeQuery) return options;
  const resume = await runPublic<string | null>('history.latestSession', {
    cwd: options.cwd, env: options.env, conventions: options.conventions,
  }, {}, signal);
  return resume === null ? options : inheritOptionCapabilities({ ...options, resume }, options);
}
