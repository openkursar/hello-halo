import { AsyncResource } from 'node:async_hooks';
import type { Options } from '../types/config.js';
import type { McpSdkServerConfigWithInstance } from '../tools/mcp/sdk-server.js';
import { zodToJsonSchema } from '../tools/mcp/zod-to-json-schema.js';
import { CALLBACK, SIGNAL, type EncodedOptions } from './options.js';
import type { CodeSearchService } from '../search/index.js';
import { codeSearchReadDenyRoots } from '../core/read-policy.js';

type Callback = (...args: any[]) => unknown;

/** Callbacks are retained only for the life of their owning session. */
export class HostCallbacks {
  private callbacks = new Map<string, Callback>();
  private nextId = 0;
  private readonly context = new AsyncResource('AgentSdkSession');
  constructor(private readonly signal: AbortSignal) {}

  private add(callback: Callback): string {
    const id = String(++this.nextId);
    this.callbacks.set(id, callback);
    return id;
  }

  encode(options: Options, codeSearch?: CodeSearchService): EncodedOptions {
    if (options.provider || options.customTools?.length) {
      throw new TypeError('Use providerConfig for a standard worker provider, or a worker setup module for custom providers and tools');
    }
    const { abortController: _abort, mcpServers, ...plain } = options;
    const servers: Record<string, unknown> = {};
    const mcpTools: EncodedOptions['mcpTools'] = [];
    for (const [name, config] of Object.entries(mcpServers ?? {})) {
      if (config.type !== 'sdk') { servers[name] = config; continue; }
      const sdkConfig = config as McpSdkServerConfigWithInstance;
      const instance = sdkConfig.instance;
      const registered = (instance as unknown as { _registeredTools?: Record<string, any> })._registeredTools;
      if (typeof instance.listTools === 'function') {
        for (const definition of instance.listTools()) {
          mcpTools.push({ server: name, name: definition.name, description: definition.description,
            inputSchema: definition.inputSchema, annotations: definition.annotations as Record<string, unknown>,
            callback: this.add((input, signal) => instance.callTool(definition.name, input, { signal })),
          });
        }
      } else if (registered) {
        for (const [toolName, definition] of Object.entries(registered)) {
          if (definition.enabled === false) continue;
          mcpTools.push({ server: name, name: toolName, description: definition.description ?? '',
            inputSchema: zodToJsonSchema(definition.inputSchema), annotations: definition.annotations,
            callback: this.add((input, signal) => definition.handler(input, { signal })),
          });
        }
      } else throw new TypeError('Unsupported in-process MCP server instance');
      servers[name] = { type: 'sdk', name: config.name,
        description: sdkConfig.description ?? instance.description,
        instructions: sdkConfig.instructions ?? instance.instructions,
      };
    }
    return {
      options: this.encodeValue({ ...plain, mcpServers: servers }) as Record<string, unknown>, mcpTools,
      ...(codeSearch ? { codeSearch: this.add(request => codeSearch.search(request)) } : {}),
      readDenyRoots: codeSearchReadDenyRoots(options),
    };
  }

  private encodeValue(value: unknown, owner?: object): unknown {
    if (typeof value === 'function') return { [CALLBACK]: this.add(value.bind(owner)) };
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(item => this.encodeValue(item));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError('Worker options must be plain data; construct class instances in a worker setup module');
    }
    if (CALLBACK in value || SIGNAL in value) throw new TypeError('Reserved worker option key');
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, this.encodeValue(child, value)]));
  }

  async call(id: string, args: unknown[], signal: AbortSignal): Promise<unknown> {
    const callback = this.callbacks.get(id);
    if (!callback || this.signal.aborted || signal.aborted) throw new Error('Session callback is no longer available');
    return this.context.runInAsyncScope(callback, undefined, ...restoreSignals(args, signal) as unknown[]);
  }

  clear(): void { this.callbacks.clear(); this.context.emitDestroy(); }
}

function restoreSignals(value: unknown, signal: AbortSignal): unknown {
  if (Array.isArray(value)) return value.map(item => restoreSignals(item, signal));
  if (!value || typeof value !== 'object') return value;
  if (SIGNAL in value) return signal;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, restoreSignals(child, signal)]));
}

