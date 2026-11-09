/** Owns HTTP work until its body has been consumed, not merely until headers arrive. */
export class RequestScope {
  private readonly lifetime = new AbortController();
  get signal(): AbortSignal { return this.lifetime.signal; }

  async run<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs = 30_000, signal?: AbortSignal): Promise<T> {
    if (this.signal.aborted) throw new Error('MCP transport is closed');
    signal?.throwIfAborted();
    const request = new AbortController();
    const abort = () => request.abort(this.signal.reason);
    this.signal.addEventListener('abort', abort, { once: true });
    const cancel = () => request.abort(signal?.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => request.abort(new Error('MCP HTTP request timed out')), timeoutMs);
    try { return await operation(request.signal); }
    finally {
      clearTimeout(timer);
      this.signal.removeEventListener('abort', abort);
      signal?.removeEventListener('abort', cancel);
    }
  }

  close(): void { this.lifetime.abort(new Error('MCP transport is closed')); }
}
