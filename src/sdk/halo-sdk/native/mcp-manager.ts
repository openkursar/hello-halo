import type { Tool, ToolContext, ToolResult } from '../types/tool.js';
import type { McpConnectionManager as ManagerContract, McpServerLiveStatus, CreateMcpConnectionManagerOptions } from '../tools/mcp/connection-manager.js';
import type { ExternalMcpConnection, McpServerConnectionStatus } from '../tools/mcp/bridge.js';
import type { McpElicitationHandler } from '../tools/mcp/client.js';
import type { Options } from '../types/config.js';
import { callbackError, loadBinding, nativeError, parseNativeValue, stringifyNativeValue, type NativeCollaborationCallback } from './binding.js';
import { NativeCallbacks } from './callbacks.js';
import { createHostCallbacks } from './host-callbacks.js';

interface ManagedHandle {
  descriptor(): string;
  start(input: string, id: string, callback: NativeCollaborationCallback, initialError?: string): Promise<string>;
  cancel(id: string): void;
}
interface ManagerHandle {
  call(name: string, input: string, callback: NativeCollaborationCallback): string;
  start(name: string, input: string, callback: NativeCollaborationCallback): Promise<string>;
  tools(): ManagedHandle[];
  ownsTool(tool: ManagedHandle): boolean;
  abort(): void;
}
interface ExternalToolHandle { descriptor(): string; start(input: string, callback: NativeCollaborationCallback): Promise<string> }
interface ExternalHandle {
  connect(configs: string, callback: NativeCollaborationCallback): Promise<string>;
  tools(): ExternalToolHandle[];
  disconnect(): void;
  whenClosed(callback: NativeCollaborationCallback): Promise<string>;
  abort(): void;
}
interface McpBinding {
  NativeMcpManager: new(configs: string, options: string, callback: NativeCollaborationCallback) => ManagerHandle;
  NativeExternalMcp: new(options: string, callback: NativeCollaborationCallback) => ExternalHandle;
}
type Descriptor = Pick<Tool, 'name' | 'description' | 'inputSchema' | 'permissionLevel' | 'mcpSource'> & { concurrencySafe?: boolean };
const binding = (): McpBinding => loadBinding() as unknown as McpBinding;

function parseDescriptor(raw: string): Descriptor {
  // Remote schemas may contain objects that resemble native control values.
  const { inputSchema, ...metadata } = JSON.parse(raw) as Descriptor;
  return { ...parseNativeValue(JSON.stringify(metadata)), inputSchema } as Descriptor;
}

function configurationValues(configs: Record<string, unknown> | undefined): unknown {
  if (!configs) return configs;
  return Object.fromEntries(Object.entries(configs).map(([name, config]) => [name,
    config && typeof config === 'object' && (config as { type?: unknown }).type === 'sdk' ? { type: 'sdk' } : config,
  ]));
}
const configurationData = (configs: Record<string, unknown> | undefined): string => stringifyNativeValue(configurationValues(configs));

class NativeMcpConnectionManager {
  private readonly callbacks = new NativeCallbacks();
  private readonly host;
  private readonly handle: ManagerHandle;
  private readonly issued = new WeakMap<Tool, ManagedHandle>();
  private nextOperation = 0;

  constructor(configs?: Record<string, unknown>, options?: CreateMcpConnectionManagerOptions) {
    const weak = new WeakRef(this);
    this.host = createHostCallbacks((verb, input) => {
      const owner = weak.deref();
      if (!owner) throw new Error('MCP callback owner is no longer available');
      if (verb === 'cancel') return owner.callbacks.cancel(input.id);
      return owner.callbacks.call(input.id, input.method, input.params);
    });
    const onElicitation = options?.onElicitation;
    const encoded = this.callbacks.encode({ ...(onElicitation ? { onElicitation: (request, extra) => onElicitation(request, extra) } : {}) } as Options, { providerCapabilities: false });
    this.handle = new (binding().NativeMcpManager)(configurationData(configs), JSON.stringify(encoded), this.host.callback);
  }
  private call<T>(name: string, args: unknown[] = []): T {
    try { return parseNativeValue(this.handle.call(name, stringifyNativeValue(args), this.host.callback)) as T; }
    catch (error) { throw this.host.error(error); }
  }
  private async start<T>(name: string, args: unknown[] = []): Promise<T> {
    try { return parseNativeValue(await this.handle.start(name, stringifyNativeValue(args), this.host.callback)) as T; }
    catch (error) { throw this.host.error(error); }
  }
  setElicitationHandler(handler: McpElicitationHandler): void {
    const encoded = this.callbacks.encode({ onElicitation: (request, extra) => handler(request, extra) } as Options, { providerCapabilities: false });
    this.call('setElicitationHandler', [encoded.onElicitation]);
  }
  addServer(name: string, config: Record<string, unknown>): void { this.call('addServer', [name, (configurationValues({ [name]: config }) as Record<string, unknown>)[name]]); }
  connectAll(): Promise<void> { return this.start('connectAll'); }
  connect(name: string): Promise<void> { return this.start('connect', [name]); }
  disconnect(name: string): void { this.call('disconnect', [name]); }
  disconnectAll(): void { this.call('disconnectAll'); this.callbacks.abort(); }
  async whenSettled(): Promise<void> { await this.start('whenSettled'); }
  restart(name: string): Promise<void> { return this.start('restart', [name]); }
  removeServer(name: string): void { this.call('removeServer', [name]); }
  toggle(name: string, enabled: boolean): Promise<void> { return this.start('toggle', [name, enabled]); }
  setServers(configs: Record<string, Record<string, unknown>>): Promise<{ added: string[]; removed: string[]; errors: Record<string, string> }> { return this.start('setServers', [configurationValues(configs)]); }
  getStatus(name: string): McpServerLiveStatus | undefined { return this.call('getStatus', [name]); }
  getAllStatuses(): Map<string, McpServerLiveStatus> { return new Map(this.call<[string, McpServerLiveStatus][]>('getAllStatuses')); }
  getStatuses(): McpServerConnectionStatus[] { return this.call('getStatuses'); }
  isConnected(name: string): boolean { return this.call('isConnected', [name]); }
  serverNames(): string[] { return this.call('serverNames'); }
  getToolCatalogRevision(): number { return this.call('getToolCatalogRevision'); }
  ownsTool(tool: Tool): boolean { const handle = this.issued.get(tool); return handle !== undefined && this.handle.ownsTool(handle); }
  getBridgedTools(): Tool[] {
    let handles: ManagedHandle[];
    try { handles = this.handle.tools(); } catch (error) { throw this.host.error(error); }
    return handles.map(handle => {
      const descriptor = parseDescriptor(handle.descriptor());
      const tool: Tool = { name: descriptor.name, mcpSource: descriptor.mcpSource, description: descriptor.description, inputSchema: descriptor.inputSchema,
        permissionLevel: descriptor.permissionLevel, execute: (input, context) => this.execute(handle, input, context) };
      this.issued.set(tool, handle); return tool;
    });
  }
  startReconnectLoop(name: string): void { this.call('startReconnectLoop', [name]); }
  private async execute(handle: ManagedHandle, input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const id = String(++this.nextOperation);
    const abort = () => handle.cancel(id);
    const initialError = context.abortSignal?.aborted ? callbackError(context.abortSignal.reason) : undefined;
    context.abortSignal?.addEventListener('abort', abort, { once: true });
    try {
      const pending = handle.start(JSON.stringify(input), id, this.host.callback, initialError);
      if (context.abortSignal?.aborted) abort();
      return parseNativeValue(await pending) as ToolResult;
    } catch (error) { throw this.host.error(error); }
    finally { context.abortSignal?.removeEventListener('abort', abort); }
  }
}
Object.defineProperty(NativeMcpConnectionManager, 'name', { value: 'McpConnectionManager' });
export type McpConnectionManager = ManagerContract;
export const McpConnectionManager = NativeMcpConnectionManager as unknown as typeof ManagerContract;
export function createMcpConnectionManager(configs?: Record<string, unknown>, options?: CreateMcpConnectionManagerOptions): ManagerContract {
  return new NativeMcpConnectionManager(configs, options) as unknown as ManagerContract;
}

class ExternalOwner {
  private readonly callbacks = new NativeCallbacks();
  private readonly host;
  private readonly handle: ExternalHandle;
  constructor() {
    const weak = new WeakRef(this);
    this.host = createHostCallbacks((verb, input) => {
      const owner = weak.deref();
      if (!owner) throw new Error('MCP callback owner is no longer available');
      if (verb === 'cancel') return owner.callbacks.cancel(input.id);
      return owner.callbacks.call(input.id, input.method, input.params);
    });
    const options = this.callbacks.encode({} as Options, { providerCapabilities: false });
    this.handle = new (binding().NativeExternalMcp)(JSON.stringify(options), this.host.callback);
  }
  async connect(configs?: Record<string, unknown>): Promise<ExternalMcpConnection> {
    try {
      const serverStatuses = parseNativeValue(await this.handle.connect(configurationData(configs), this.host.callback)) as McpServerConnectionStatus[];
      const tools = this.handle.tools().map(handle => {
        const descriptor = parseDescriptor(handle.descriptor());
        return { name: descriptor.name, mcpSource: descriptor.mcpSource, description: descriptor.description, inputSchema: descriptor.inputSchema,
          permissionLevel: descriptor.permissionLevel,
          isConcurrencySafe: () => descriptor.concurrencySafe === true,
          execute: async (input: Record<string, unknown>) => {
            try { return parseNativeValue(await handle.start(JSON.stringify(input), this.host.callback)) as ToolResult; }
            catch (error) { throw this.host.error(error); }
          },
        } satisfies Tool;
      });
      return { tools, serverStatuses, disconnect: () => { this.handle.disconnect(); this.callbacks.abort(); } };
    } catch (error) { this.handle.abort(); throw this.host.error(error); }
  }
}
export async function connectExternalMcpServers(configs?: Record<string, unknown>): Promise<ExternalMcpConnection> {
  try { return await new ExternalOwner().connect(configs); } catch (error) { throw nativeError(error); }
}
