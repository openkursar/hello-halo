import { randomUUID } from 'node:crypto';
import type { SDKSession, LiveInputOptions, InputOptions, SessionCloseOptions, SessionRuntimeStats } from '../core/session.js';
import type { SDKMessage } from '../core/query-types.js';
import type { PermissionMode, SlashCommand, ModelInfo, McpServerStatus, McpSetServersResult } from '../types/config.js';
import type { Goal, GoalInput } from '../types/goal.js';
import { getLogger } from '../utils/logger.js';
import { RpcPeer, deserializeError } from './rpc.js';
import type { StreamBatch } from './stream.js';

export interface WorkerSession extends Omit<SDKSession, 'getGoal' | 'setGoal'> {
  getGoal(): Promise<Goal | null>;
  setGoal(goal: GoalInput | null): Promise<Goal | null>;
  readonly threadId: number;
  readonly query: WorkerSessionQuery;
  readonly abortController: AbortController;
}
export interface WorkerSessionQuery {
  transport: { isReady(): boolean; readonly ready: boolean; onExit(callback: (error?: Error) => void): () => void };
  supportedCommands(): Promise<SlashCommand[]>;
  supportedModels(): Promise<ModelInfo[]>;
  mcpServerStatus(): Promise<McpServerStatus[]>;
  reconnectMcpServer(name: string): Promise<void>;
  toggleMcpServer(name: string, enabled: boolean): Promise<void>;
  setMcpServers(servers: Record<string, unknown>): Promise<McpSetServersResult>;
  stopTask(id: string): Promise<void>;
}

interface Reader {
  id: string;
  batch?: StreamBatch;
  wake?: () => void;
  failure?: Error;
  done: boolean;
}

export class RemoteSession implements WorkerSession {
  readonly abortController = new AbortController();
  readonly query: WorkerSessionQuery;
  private pending = new Map<string, { options?: LiveInputOptions; bytes: number }>();
  private pendingBytes = 0;
  private listeners = new Set<(error?: Error) => void>();
  private reader?: Reader;
  private closing?: Promise<void>;
  private failure?: Error;
  private retired = false;

  constructor(
    readonly scope: string,
    readonly sessionId: string,
    readonly threadId: number,
    private readonly peer: RpcPeer,
    private readonly dispose: () => Promise<void>,
    private readonly onFailure: (error: Error) => void,
  ) {
    const self = this;
    this.query = {
      transport: {
        isReady: () => !self.retired,
        get ready() { return !self.retired; },
        onExit: callback => { self.listeners.add(callback); return () => self.listeners.delete(callback); },
      },
      supportedCommands: () => this.call('supportedCommands', [], true),
      supportedModels: () => this.call('supportedModels', [], true),
      mcpServerStatus: () => this.call('mcpServerStatus', [], true),
      reconnectMcpServer: name => this.call('reconnectMcpServer', [name], true),
      toggleMcpServer: (name, enabled) => this.call('toggleMcpServer', [name, enabled], true),
      setMcpServers: servers => this.call('setMcpServers', [servers], true),
      stopTask: id => this.call('stopTask', [id], true),
    };
    this.abortController.signal.addEventListener('abort', () => this.close(), { once: true });
  }

  private async call<T>(method: string, args: unknown[], query = false): Promise<T> {
    if (this.retired) return Promise.reject(this.failure ?? new Error('Session is closed'));
    return this.peer.request(this.scope, 'call', { method, args, query });
  }

  hasPendingInput(): boolean { return !this.retired && this.pending.size > 0; }
  getRuntimeStats(): Promise<SessionRuntimeStats> { return this.call('getRuntimeStats', []); }

  diagnostics(): { pendingInputs: number; pendingInputBytes: number; bufferedEvents: number } {
    return { pendingInputs: this.pending.size, pendingInputBytes: this.pendingBytes, bufferedEvents: this.reader?.batch?.messages.length ?? 0 };
  }

  private enqueue(message: string | Record<string, unknown>, live: boolean, options?: LiveInputOptions): Promise<void> {
    if (this.retired) throw this.failure ?? new Error('Session is closed');
    const bytes = typeof message === 'string' ? message.length * 2 : JSON.stringify(message).length * 2;
    if (this.pending.size >= 256 || this.pendingBytes + bytes > 64 * 1024 * 1024) throw new Error('Session input capacity exceeded');
    const id = randomUUID();
    this.pending.set(id, { bytes, options });
    this.pendingBytes += bytes;
    const remove = () => {
      const input = this.pending.get(id);
      if (input) { this.pending.delete(id); this.pendingBytes -= input.bytes; }
    };
    let accepted: Promise<void>;
    try { accepted = this.peer.request<void>(this.scope, 'send', { id, message, live }); }
    catch (error) { remove(); throw error; }
    return accepted.catch(error => {
      remove();
      if (!this.retired) this.fail(error);
      throw error;
    });
  }

  async send(message: string | Record<string, unknown>, options?: InputOptions): Promise<void> { await this.enqueue(message, false, options); }

  sendIntoLiveTurn(message: string | Record<string, unknown>, options?: LiveInputOptions): boolean {
    if (this.retired) return false;
    try {
      void this.enqueue(message, true, options).catch(error => {
        if (!this.retired) this.fail(error);
      });
      return true;
    } catch (error) {
      getLogger('Worker').warn('Live input refused before acceptance', { scope: this.scope, error: String(error) });
      return false;
    }
  }

  receipt(id: string, withdrawn: boolean): void {
    const input = this.pending.get(id);
    if (!input) return;
    this.pending.delete(id);
    this.pendingBytes -= input.bytes;
    try { if (withdrawn) input.options?.onWithdrawn?.(); else input.options?.onConsumed?.(); }
    catch (error) { getLogger('Worker').warn('Input receipt handler failed', { scope: this.scope, error: String(error) }); }
  }

  async withdrawUnreadInput(): Promise<number> {
    if (this.retired) return Promise.resolve(0);
    return this.peer.request(this.scope, 'withdraw');
  }

  acceptBatch(batch: StreamBatch): void {
    const reader = this.reader;
    if (!reader || reader.id !== batch.streamId) return;
    if (reader.batch) { this.fail(new Error('Worker stream exceeded its receive window')); return; }
    if (batch.error) reader.failure = deserializeError(batch.error);
    reader.done = !!batch.done;
    if (batch.messages.length) reader.batch = batch;
    reader.wake?.();
    reader.wake = undefined;
  }

  async *stream(): AsyncGenerator<SDKMessage, void, undefined> {
    if (this.retired) throw this.failure ?? new Error('Session is closed');
    if (this.reader) throw new Error('A stream is already being consumed');
    const reader: Reader = { id: randomUUID(), done: false };
    this.reader = reader;
    let acknowledged: StreamBatch | undefined;
    try {
      await this.peer.request(this.scope, 'stream', { streamId: reader.id });
      while (true) {
        if (reader.failure) throw reader.failure;
        const batch = reader.batch;
        if (batch) {
          reader.batch = undefined;
          acknowledged = batch;
          for (const message of batch.messages) {
            if (this.retired) { if (this.failure) throw this.failure; return; }
            yield message;
          }
          this.peer.notify('ack', { scope: this.scope, sequence: batch.sequence });
          acknowledged = undefined;
        } else if (reader.done || this.retired) return;
        else await new Promise<void>(resolve => { reader.wake = resolve; });
      }
    } finally {
      if (acknowledged) this.peer.notify('ack', { scope: this.scope, sequence: acknowledged.sequence });
      if (!reader.done && !this.retired) {
        await this.peer.request(this.scope, 'returnStream', { streamId: reader.id });
      }
      if (this.reader === reader) this.reader = undefined;
    }
  }

  interrupt(): Promise<void> { return this.call('interrupt', []); }
  setModel(model: string | undefined): Promise<void> { return this.call('setModel', [model]); }
  setMaxThinkingTokens(value: number | null): Promise<void> { return this.call('setMaxThinkingTokens', [value]); }
  setPermissionMode(mode: PermissionMode): Promise<void> { return this.call('setPermissionMode', [mode]); }
  getGoal(): Promise<Goal | null> { return this.call('getGoal', []); }
  setGoal(goal: GoalInput | null): Promise<Goal | null> { return this.call('setGoal', [goal]); }
  flush(): Promise<void> { return this.closing ?? this.call('flush', []); }

  close(options?: SessionCloseOptions): void {
    if (this.closing) return;
    this.retire();
    const abortCleanup = () => this.peer.notify('abortCleanup', { scope: this.scope });
    options?.signal?.addEventListener('abort', abortCleanup, { once: true });
    if (options?.signal?.aborted) abortCleanup();
    this.closing = this.dispose().finally(() => options?.signal?.removeEventListener('abort', abortCleanup));
    void this.closing.then(() => this.notifyExit(), error => {
      getLogger('Worker').error('Session close failed', { scope: this.scope, error: String(error) });
      this.notifyExit(error);
      this.onFailure(error);
    });
  }

  fail(error: Error): void {
    if (this.retired) return;
    this.failure = error;
    this.retire(error);
    this.close();
  }

  private retire(error?: Error): void {
    if (this.retired) return;
    this.retired = true;
    this.pending.clear();
    this.pendingBytes = 0;
    if (this.reader) { this.reader.failure = error; this.reader.batch = undefined; this.reader.wake?.(); }
    if (error) this.notifyExit(error);
  }

  private notifyExit(error?: Error): void {
    for (const listener of this.listeners) {
      try { listener(error); } catch (failure) { getLogger('Worker').warn('Session exit handler failed', { scope: this.scope, error: String(failure) }); }
    }
    this.listeners.clear();
  }

  async [Symbol.asyncDispose](): Promise<void> { this.close(); await this.closing; }
}
