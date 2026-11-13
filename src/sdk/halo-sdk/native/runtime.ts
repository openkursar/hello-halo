import { randomUUID } from 'node:crypto';
import { acquireRuntimeTranscript } from '../utils/runtime-ownership.js';
import { transcriptLocks } from '../utils/locks.js';
import type { Options } from '../types/config.js';
import type { SDKMessage } from '../core/query-types.js';
import type { ReadSessionToolContextModeOptions, SessionToolContextMode } from '../core/session-tool-context.js';
import { getLogger } from '../utils/logger.js';
import { NativeSdkSession, prepareSessionContinuation } from './session.js';
import { createProvider, type ProviderConfig } from './provider-factory.js';
import { reapOwnedProcesses } from './process-owner.js';
import { inheritOptionCapabilities } from './options.js';
import { loadBinding, runtimeInfo, nativeError, type NativeHistoryHandle } from './binding.js';

export interface NativeSetup {
  module: string;
  exportName?: string;
  data?: unknown;
}

export interface NativeRuntimeOptions {
  sessionStartupTimeoutMs?: number;
  closeTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  setup?: NativeSetup;
}

export interface NativePlacement { group?: string; setup?: NativeSetup }
/** Standard providers are constructed before the optional setup module runs. */
export interface NativeSessionOptions extends Options { providerConfig?: ProviderConfig }

function positive(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new RangeError(`Invalid ${name}`);
  return result;
}

function aborted(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
}

async function withSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw aborted(signal);
  let cancel!: () => void;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      cancel = () => reject(aborted(signal));
      signal.addEventListener('abort', cancel, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', cancel); }
}

export class NativeRuntime {
  private closed = false;
  private initialized = false;
  private readonly sessions = new Set<NativeSdkSession>();
  private readonly preparations = new Set<AbortController>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly inspections = new Map<NativeHistoryHandle, Promise<string>>();
  private shutdown?: Promise<void>;
  private maintenance?: ReturnType<typeof setInterval>;
  private readonly preparationTimeout: number;
  private readonly closeTimeout: number;
  private readonly shutdownTimeout: number;

  constructor(private readonly options: NativeRuntimeOptions = {}) {
    for (const key of Object.keys(options)) {
      if (!['sessionStartupTimeoutMs', 'closeTimeoutMs', 'shutdownTimeoutMs', 'setup'].includes(key)) {
        throw new TypeError(`Native runtime does not support option: ${key}`);
      }
    }
    this.preparationTimeout = positive(options.sessionStartupTimeoutMs, 120_000, 'sessionStartupTimeoutMs');
    this.closeTimeout = positive(options.closeTimeoutMs, 30_000, 'closeTimeoutMs');
    this.shutdownTimeout = positive(options.shutdownTimeoutMs, this.closeTimeout, 'shutdownTimeoutMs');
  }

  async initialize(): Promise<void> {
    if (this.closed) throw new Error('Native runtime is closed');
    loadBinding();
    if (!this.initialized) {
      this.initialized = true;
      const info = runtimeInfo();
      getLogger('Native').info('Native runtime initialized', { implementation: info.implementation, buildId: info.buildId, abiVersion: info.abiVersion });
      this.maintenance = setInterval(() => getLogger('Native').info('Native runtime state', {
        sessions: this.sessions.size, preparing: this.preparations.size,
      }), 300_000);
      this.maintenance.unref();
    }
  }

  createSession(options: NativeSessionOptions, placement: NativePlacement = {}): Promise<NativeSdkSession> {
    const pending = this.prepare(options, placement);
    this.pending.add(pending);
    void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending));
    return pending;
  }

  private async prepare(options: NativeSessionOptions, placement: NativePlacement): Promise<NativeSdkSession> {
    await this.initialize();
    const controller = new AbortController();
    const abort = () => controller.abort(options.abortController?.signal.reason);
    options.abortController?.signal.addEventListener('abort', abort, { once: true });
    if (options.abortController?.signal.aborted) abort();
    this.preparations.add(controller);
    const deadline = setTimeout(() => controller.abort(new Error('Native session preparation timed out')), this.preparationTimeout);
    deadline.unref();
    let session: NativeSdkSession | undefined;
    const release = () => options.abortController?.signal.removeEventListener('abort', abort);
    try {
      controller.signal.throwIfAborted();
      const setup = placement.setup ?? this.options.setup;
      const { providerConfig, ...sessionOptions } = options;
      let prepared: Options = inheritOptionCapabilities({ ...sessionOptions, abortController: controller }, options);
      if (providerConfig !== undefined) {
        if (providerConfig === null || typeof providerConfig.apiKey !== 'string') {
          throw new TypeError('providerConfig must provide an apiKey string');
        }
        prepared.provider = createProvider(providerConfig);
      }
      if (setup) {
        if (new URL(setup.module).protocol !== 'file:') throw new TypeError('Native setup must be a local file URL');
        const module = await withSignal(import(setup.module), controller.signal);
        const configure = module[setup.exportName ?? 'setup'];
        if (typeof configure !== 'function') throw new TypeError('Native setup export is not a function');
        prepared = await withSignal(Promise.resolve().then(() => configure(prepared, setup.data)), controller.signal);
      }
      if (prepared.continue) prepared = await prepareSessionContinuation(prepared, controller.signal);
      if (this.closed) throw new Error('Native runtime is closed');
      controller.signal.throwIfAborted();
      const owner = randomUUID();
      inheritOptionCapabilities(prepared, options);
      session = new NativeSdkSession(inheritOptionCapabilities({ ...prepared, abortController: controller }, prepared), ({ path, sessionId }, signal) =>
        acquireRuntimeTranscript(owner, path, sessionId, () => this.closed || controller.signal.aborted || (session?.isClosing() ?? false), signal), this.closeTimeout);
      this.sessions.add(session);
      session.query.transport.onExit(() => { this.sessions.delete(session!); release(); });
      try { await withSignal(session.initialized(), controller.signal); }
      catch (error) { throw session.initializationError() ?? error; }
      return session;
    } catch (error) {
      release();
      if (session) { session.close(); await this.drain(session, this.closeTimeout).catch(() => undefined); }
      throw error;
    } finally {
      clearTimeout(deadline);
      this.preparations.delete(controller);
    }
  }

  async *query(params: { prompt: string; options?: NativeSessionOptions }, placement: NativePlacement = {}): AsyncGenerator<SDKMessage, void, undefined> {
    const options = inheritOptionCapabilities({ ...params.options, nativeQuery: true }, params.options ?? {});
    const session = await this.createSession(options, placement);
    try { await session.send(params.prompt); yield* session.stream(); }
    finally { session.close(); await this.drain(session, this.closeTimeout); }
  }

  async readSessionToolContextMode(sessionId: string, options: ReadSessionToolContextModeOptions,
    controls: { signal?: AbortSignal; group?: string } = {}): Promise<SessionToolContextMode> {
    controls.signal?.throwIfAborted();
    await this.initialize();
    const inspection = new (loadBinding().NativeHistoryRead)(sessionId, JSON.stringify(options));
    const result = inspection.result();
    this.inspections.set(inspection, result);
    const cancel = () => inspection.cancel();
    controls.signal?.addEventListener('abort', cancel, { once: true });
    if (controls.signal?.aborted || this.closed) cancel();
    try { return await result as SessionToolContextMode; }
    catch (error) { throw nativeError(error); }
    finally { controls.signal?.removeEventListener('abort', cancel); this.inspections.delete(inspection); }
  }

  diagnostics(): Record<string, unknown> {
    return { ...JSON.parse(loadBinding().runtimeDiagnostics()), closed: this.closed,
      sessions: this.sessions.size, preparing: this.preparations.size, inspections: this.inspections.size, transcriptLocks: transcriptLocks.size,
      implementation: 'rust', native: runtimeInfo() };
  }

  private async drain(session: NativeSdkSession, timeout: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const cleanup = async () => { await session.flush(); await reapOwnedProcesses(session); };
      await Promise.race([cleanup(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          getLogger('Native').error('Native runtime cleanup deadline expired', { sessionId: session.sessionId, timeoutMs: timeout });
          reject(new Error('Native session cleanup timed out'));
        }, timeout);
      })]);
    } finally { clearTimeout(timer); }
  }

  close(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closed = true;
    clearInterval(this.maintenance);
    for (const controller of this.preparations) controller.abort();
    for (const inspection of this.inspections.keys()) inspection.cancel();
    const sessions = [...this.sessions];
    for (const session of sessions) session.close(undefined, this.shutdownTimeout);
    const hookDeadline = setTimeout(() => { for (const session of sessions) session.abortCleanup(); }, Math.max(1, Math.floor(this.shutdownTimeout / 2)));
    this.shutdown = Promise.all([
      ...sessions.map(session => this.drain(session, this.shutdownTimeout)),
      ...[...this.inspections.values()].map(read => read.catch(() => undefined)),
      ...[...this.pending].map(preparation => preparation.catch(() => undefined)),
    ]).then(() => { this.sessions.clear(); }).finally(() => clearTimeout(hookDeadline));
    return this.shutdown;
  }
}

export function createNativeRuntime(options?: NativeRuntimeOptions): NativeRuntime { return new NativeRuntime(options); }
