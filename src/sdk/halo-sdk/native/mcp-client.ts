import { randomUUID } from 'node:crypto';
import type { McpClient as ClientContract, McpElicitationHandler, McpServerInfo, McpToolDefinition, McpCallToolResult } from '../tools/mcp/client.js';
import type { McpTransport } from '../tools/mcp/jsonrpc.js';
import { getLogger } from '../utils/logger.js';
import { createHostCallbacks } from './host-callbacks.js';
import { loadBinding, nativeError, type NativeMcpClientHandle } from './binding.js';
import { decodeWire, encodeWire } from './wire.js';

export type { McpElicitationHandler, McpServerInfo, McpToolDefinition, McpCallToolResult } from '../tools/mcp/client.js';
export type McpClient = ClientContract;
export const McpClient = class McpClient {
  private handle?: NativeMcpClientHandle;
  private readonly lifetime = new AbortController();
  private tools: McpToolDefinition[] = [];
  private server: McpServerInfo | null = null;
  private serverRevision = 0;
  constructor(private readonly transport: McpTransport, private readonly serverName: string, private readonly onElicitation?: McpElicitationHandler) {}
  private native(): NativeMcpClientHandle { return this.handle ??= new (loadBinding().NativeMcpClient)(JSON.stringify(encodeWire(this.serverName)), this.onElicitation !== undefined); }
  get initialized(): boolean { return this.handle ? decodeWire(JSON.parse(this.handle.value('initialized'))) as boolean : false; }
  getTools(): McpToolDefinition[] { return this.tools; }
  getServerInfo(): McpServerInfo | null {
    if (this.handle) { const revision = decodeWire(JSON.parse(this.handle.value('serverInfoRevision'))) as number;
      if (revision !== this.serverRevision) { this.server = decodeWire(JSON.parse(this.handle.value('serverInfo'))) as McpServerInfo | null; this.serverRevision = revision; } }
    return this.server;
  }
  getInstructions(): string | undefined { return this.handle ? decodeWire(JSON.parse(this.handle.value('instructions'))) as string | undefined : undefined; }
  private operation<T>(method: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const native = this.native(), transport = this.transport, handler = this.onElicitation, ownSignal = this.lifetime.signal;
    const initiallyAborted = signal?.aborted === true;
    let submitted = false;
    let nextReference = 0;
    const references = new Map<string, any>();
    const capture = (value: unknown) => { const reference = String(++nextReference); references.set(reference, value); return { reference }; };
    const restore = (receipt: { value?: unknown; reference?: string | null }): any => {
      if (typeof receipt.reference !== 'string') return receipt.value;
      if (!references.has(receipt.reference)) throw new Error('MCP result reference is no longer available');
      return references.get(receipt.reference);
    };
    const invokeElicitation = (params: unknown) => this.operation<Record<string, unknown>>('elicitation', params);
    const project = (response: any, kind: string): unknown => {
      if (response.error) return kind === 'tools'
        ? { kind: 'error', ...capture(response.error.message) }
        : { kind: 'error', message: `${response.error.message}` };
      const result = response.result;
      if (kind === 'initialize') {
        const capabilitiesReference = capture(result?.capabilities ?? {}).reference;
        return {
          kind: 'initialize', capabilitiesReference,
          server: {
            name: typeof result?.serverInfo?.name === 'string' ? result.serverInfo.name : this.serverName,
            version: typeof result?.serverInfo?.version === 'string' ? result.serverInfo.version : 'unknown',
            ...(typeof result?.serverInfo?.description === 'string' ? { description: result.serverInfo.description } : {}),
          },
          instructions: typeof result?.instructions === 'string' ? result.instructions : undefined,
        };
      }
      if (kind === 'tools') {
        const tools = result?.tools;
        return tools == null ? { kind: 'tools', value: [] } : { kind: 'tools', ...capture(tools) };
      }
      return result == null ? { kind: 'empty' } : { kind: 'result', ...capture(result) };
    };
    const controllers = new Map<string, AbortController>();
    const callbacks = createHostCallbacks((kind, frame) => {
      if (kind === 'cancel') { controllers.get(frame.id)?.abort(); return undefined; }
      if (kind !== 'call') throw new Error('Unknown native host callback');
      const controller = new AbortController(); controllers.set(frame.id, controller);
      let result: unknown;
      try {
        const params = frame.params;
        if (frame.method === 'mcp.elicitation') {
          const request = { serverName: this.serverName, ...((payload as Record<string, unknown>) ?? {}) };
          result = Promise.resolve(handler?.(request, { signal: ownSignal })).then(value => ({ reference: capture(value).reference }));
        }
        else if (frame.method === 'mcp.client.tools') { this.tools = restore(params); result = undefined; }
        else if (frame.method === 'mcp.client.capabilities') result = Boolean(restore(params)?.tools);
        else if (frame.method === 'mcp.client.warning') {
          getLogger('MCP:Client').warn('tools/list failed', { server: this.serverName, err: restore(params) }); result = undefined;
        }
        else if (frame.method === 'mcp.transport') {
          const args = params.args as any[];
          if (params.method === 'setRequestHandler') { transport.setRequestHandler(args[0], invokeElicitation); result = undefined; }
          else if (params.method === 'send') {
            if (method === 'callTool' && args[0].method === 'tools/call') args[0].params.arguments = (payload as { arguments?: unknown }).arguments;
            if (args[1]?.nativeSignal) result = Promise.resolve().then(() => { signal?.throwIfAborted(); submitted = true; return transport.send(args[0], signal); });
            else result = transport.send(args[0]);
            result = Promise.resolve(result).then(response => project(response, params.response));
          }
          else if (params.method === 'wasSubmitted') result = submitted;
          else if (params.method === 'notify') result = transport.notify(args[0]);
          else if (params.method === 'notifyDetached') {
            void transport.notify(args[0]).catch(error => getLogger('MCP:Client').warn('Tool cancellation could not be delivered', { server: this.serverName, error: String(error) })); result = undefined;
          } else throw new Error(`Unknown MCP transport operation: ${String(params.method)}`);
        } else throw new Error(`Unknown MCP client callback: ${String(frame.method)}`);
      } catch (error) { controllers.delete(frame.id); throw error; }
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') return Promise.resolve(result).finally(() => controllers.delete(frame.id));
      controllers.delete(frame.id); return result;
    }, { errorMode: 'opaque' });
    const id = randomUUID(), cancel = () => native.cancel(id);
    signal?.addEventListener('abort', cancel, { once: true });
    let promise: Promise<string>;
    const data = method === 'callTool' ? { name: (payload as { name: string }).name } : undefined;
    try { promise = native.start(method, JSON.stringify(encodeWire(data)), id, initiallyAborted, callbacks.callback); }
    catch (error) { signal?.removeEventListener('abort', cancel); callbacks.release(); throw nativeError(error); }
    if (signal?.aborted) cancel();
    return promise.then(raw => method === 'initialize' ? undefined as T : restore(decodeWire(JSON.parse(raw)) as { value?: unknown; reference?: string }) as T, error => {
      if (initiallyAborted && signal?.aborted) throw signal.reason;
      throw callbacks.error(error);
    }).finally(() => { signal?.removeEventListener('abort', cancel); callbacks.release(); references.clear(); });
  }
  async initialize(): Promise<void> { await this.operation('initialize', {}); }
  async callTool(toolName: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallToolResult> { return await this.operation('callTool', { name: toolName, arguments: args }, signal); }
  close(): void {
    this.lifetime.abort(); this.transport.close(); this.handle?.close();
    this.tools = []; this.server = null;
    if (this.handle) this.serverRevision = decodeWire(JSON.parse(this.handle.value('serverInfoRevision'))) as number;
  }
  whenClosed(): Promise<void> { return this.transport.whenClosed?.() ?? Promise.resolve(); }
} as unknown as typeof ClientContract;
