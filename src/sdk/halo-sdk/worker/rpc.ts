import { randomUUID } from 'node:crypto';

/** `code` and `reason` let the host tell typed SDK errors apart once the class is gone. */
export interface WireError { name: string; message: string; stack?: string; code?: string; reason?: string }
export function serializeError(error: unknown): WireError {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) };
  const { code, reason } = error as { code?: unknown; reason?: unknown };
  return {
    name: error.name, message: error.message, stack: error.stack,
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof reason === 'string' ? { reason } : {}),
  };
}
export function deserializeError(error: WireError): Error {
  const constructors = new Map<string, new (message?: string) => Error>([
    ['Error', Error], ['TypeError', TypeError], ['RangeError', RangeError], ['SyntaxError', SyntaxError],
    ['ReferenceError', ReferenceError], ['URIError', URIError], ['EvalError', EvalError],
  ]);
  const Constructor = constructors.get(error.name) ?? Error;
  return Object.assign(new Constructor(error.message), {
    name: error.name, stack: error.stack,
    ...(error.code !== undefined ? { code: error.code } : {}),
    ...(error.reason !== undefined ? { reason: error.reason } : {}),
  });
}
export function aborted(): Error {
  return Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
}

type Frame =
  | { type: 'request'; id: string; scope: string; method: string; value: unknown }
  | { type: 'response'; id: string; value?: unknown; error?: WireError }
  | { type: 'cancel'; id: string }
  | { type: 'event'; event: string; value: unknown };

interface Pending {
  scope: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

/** Bidirectional RPC; every request belongs to a disposable session scope. */
export class RpcPeer {
  private pending = new Map<string, Pending>();
  private incoming = new Map<string, { scope: string; controller: AbortController }>();
  private failure: Error | undefined;
  onRequest: (method: string, value: any, scope: string, signal: AbortSignal) => unknown = () => {
    throw new Error('RPC handler not installed');
  };
  onEvent: (event: string, value: any) => void = () => {};

  constructor(private readonly post: (frame: Frame) => void, private readonly maxPending = 512) {}

  get pendingCount(): number { return this.pending.size; }
  get incomingCount(): number { return this.incoming.size; }

  request<T>(scope: string, method: string, value?: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    if (this.failure) throw this.failure;
    if (options.signal?.aborted) throw aborted();
    if (this.pending.size >= this.maxPending) throw new Error('Worker RPC capacity exceeded');
    const id = randomUUID();
    const result = new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cancel = (error: Error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.cleanup();
        reject(error);
        this.post({ type: 'cancel', id });
      };
      const onAbort = () => cancel(aborted());
      this.pending.set(id, {
        scope, resolve: value => resolve(value as T), reject,
        cleanup: () => { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); },
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.timeoutMs) timer = setTimeout(() => cancel(new Error(`Worker ${method} timed out`)), options.timeoutMs);
    });
    try { this.post({ type: 'request', id, scope, method, value }); }
    catch (error) {
      this.pending.get(id)?.cleanup();
      this.pending.delete(id);
      throw error;
    }
    return result;
  }

  notify(event: string, value?: unknown): void {
    if (!this.failure) this.post({ type: 'event', event, value });
  }

  receive(frame: Frame): void {
    if (this.failure) return;
    if (frame.type === 'response') {
      const pending = this.pending.get(frame.id);
      if (!pending) return; // A cancelled request may finish after its caller retired.
      this.pending.delete(frame.id);
      pending.cleanup();
      if (frame.error) pending.reject(deserializeError(frame.error));
      else pending.resolve(frame.value);
    } else if (frame.type === 'cancel') {
      this.incoming.get(frame.id)?.controller.abort();
    } else if (frame.type === 'event') {
      this.onEvent(frame.event, frame.value);
    } else if (frame.type === 'request') {
      if (this.incoming.size >= this.maxPending) {
        this.post({ type: 'response', id: frame.id, error: serializeError(new Error('Worker RPC capacity exceeded')) });
        return;
      }
      const controller = new AbortController();
      this.incoming.set(frame.id, { scope: frame.scope, controller });
      void this.dispatch(frame, controller.signal);
    }
  }

  private async dispatch(frame: Extract<Frame, { type: 'request' }>, signal: AbortSignal): Promise<void> {
    let onAbort!: () => void;
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(aborted());
        signal.addEventListener('abort', onAbort, { once: true });
      });
      const value = await Promise.race([this.onRequest(frame.method, frame.value, frame.scope, signal), cancelled]);
      if (!this.failure) this.post({ type: 'response', id: frame.id, value });
    } catch (error) {
      if (!this.failure) this.post({ type: 'response', id: frame.id, error: serializeError(error) });
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.incoming.delete(frame.id);
    }
  }

  cancelScope(scope: string, error = aborted(), cancelIncoming = true): void {
    for (const [id, pending] of this.pending) {
      if (pending.scope !== scope) continue;
      this.pending.delete(id);
      pending.cleanup();
      pending.reject(error);
      if (!this.failure) this.post({ type: 'cancel', id });
    }
    if (cancelIncoming) for (const incoming of this.incoming.values()) {
      if (incoming.scope === scope) incoming.controller.abort();
    }
  }

  close(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
    this.pending.clear();
    for (const incoming of this.incoming.values()) incoming.controller.abort();
    this.incoming.clear();
  }
}
