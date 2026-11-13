import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import type { HttpTransportOptions, SSETransportOptions, StdioTransportOptions } from '../tools/mcp/transports.js';
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse, ServerRequestHandler } from '../tools/mcp/jsonrpc.js';
import { getLogger } from '../utils/logger.js';
import { createHostCallbacks } from './host-callbacks.js';
import { loadBinding, nativeError, parseNativeValue, stringifyNativeValue, type NativeMcpTransportHandle } from './binding.js';

export type { HttpTransportOptions, SSETransportOptions, StdioTransportOptions } from '../tools/mcp/transports.js';
type Kind = 'stdio' | 'sse' | 'http';
class Transport {
  private native?: NativeMcpTransportHandle;
  private bridge?: ReturnType<typeof createHostCallbacks>;
  private readonly handlers = new Map<string, ServerRequestHandler>();
  private opening?: Promise<void>;
  protected retirement: Promise<void> = Promise.resolve();
  constructor(private readonly kind: Kind, private readonly options: StdioTransportOptions | SSETransportOptions | HttpTransportOptions) {}
  private handle(): NativeMcpTransportHandle {
    if (this.native) return this.native;
    const callbacks = new WeakRef(this.handlers);
    this.bridge = createHostCallbacks((kind, frame) => {
      if (kind === 'cancel') return undefined;
      if (kind === 'call' && frame.method === 'mcp.connectionReady') return Promise.resolve(undefined);
      if (kind === 'call' && frame.method === 'mcp.transport.request') {
        const handler = callbacks.deref()?.get(frame.params.callbackId);
        if (!handler) throw new Error('MCP request handler is no longer available');
        return Promise.resolve(handler(frame.params.hasParams ? frame.params.params : undefined)).then(value => ({ value }));
      }
      throw new Error('Unknown native host callback');
    }, { errorDetails: error => ({ message: error instanceof Error ? error.message : String(error) }) });
    try {
      this.native = new (loadBinding().NativeMcpTransport)(stringifyNativeValue({ ...this.options, type: this.kind, nativeHostConnectionEvents: true }),
        JSON.stringify({ nativeProcessEnv: { ...process.env }, nativeHomeDirectory: homedir(), nativeTempDirectory: tmpdir(), nativeProcessCwd: process.cwd() }), this.bridge.callback);
      for (const method of this.handlers.keys()) this.native.setRequestHandler(method, method);
      return this.native;
    } catch (error) { throw nativeError(error); }
  }
  get connected(): boolean { return this.native?.connected() ?? false; }
  setRequestHandler(method: string, handler: ServerRequestHandler): void {
    this.handlers.set(method, handler);
    if (this.native) this.native.setRequestHandler(method, method);
  }
  private operation<T>(method: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const handle = this.handle(), id = randomUUID(), cancel = () => handle.cancel(id);
    signal?.addEventListener('abort', cancel, { once: true });
    let promise: Promise<string>;
    try { promise = handle.start(method, method === 'send' || method === 'notify' ? JSON.stringify(payload) : stringifyNativeValue(payload), id, signal?.aborted === true, this.bridge!.callback); }
    catch (error) { signal?.removeEventListener('abort', cancel); return Promise.reject(nativeError(error)); }
    if (signal?.aborted) cancel();
    return promise.then(raw => (method === 'send' ? JSON.parse(raw) : parseNativeValue(raw)) as T, error => {
      const failure = this.bridge!.error(error);
      if (this.kind === 'http' && signal?.aborted && ['ABORTED', 'MCP_CANCELLED'].includes(String((failure as { code?: string })?.code))) throw signal.reason;
      throw failure;
    }).finally(() => signal?.removeEventListener('abort', cancel));
  }
  connect(): Promise<void> {
    if (this.kind !== 'http' && this.opening) return this.opening;
    if (this.connected) return Promise.resolve();
    const opening = this.operation<void>('connect', {});
    if (this.kind !== 'http') {
      this.opening = opening;
      void opening.finally(() => { if (this.opening === opening) this.opening = undefined; }).catch(() => undefined);
    }
    return opening;
  }
  protected async sendRequest(request: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse> { return await this.operation('send', request, this.kind === 'http' ? signal : undefined); }
  async notify(notification: JsonRpcNotification): Promise<void> { await this.operation('notify', notification); }
  close(): void {
    this.opening = undefined;
    if (!this.native) return;
    try { this.retirement = this.native.close(); }
    catch (error) { throw nativeError(error); }
    void this.retirement.catch(error => getLogger('MCP:Transport').warn('MCP transport retirement failed', { transport: this.kind, error: String(error) }));
  }
}
export class StdioTransport extends Transport {
  constructor(options: StdioTransportOptions) { super('stdio', options); }
  send(request: JsonRpcRequest): Promise<JsonRpcResponse> { return this.sendRequest(request); }
}
export class SSETransport extends Transport {
  constructor(options: SSETransportOptions) { super('sse', options); }
  send(request: JsonRpcRequest): Promise<JsonRpcResponse> { return this.sendRequest(request); }
}
export class HttpTransport extends Transport {
  constructor(options: HttpTransportOptions) { super('http', options); }
  send(request: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse> { return this.sendRequest(request, signal); }
  whenClosed(): Promise<void> { return this.retirement; }
}
