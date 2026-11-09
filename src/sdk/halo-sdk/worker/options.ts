import type { Options } from '../types/config.js';
import type { CallToolResult } from '../tools/mcp/sdk-server.js';
import type { RpcPeer } from './rpc.js';
import { bindCodeSearchBridge } from '../core/code-search.js';
import type { CodeSearchResult } from '../search/index.js';
import { bindReadDenyFloor } from '../core/read-policy.js';

export const CALLBACK = '__haloSdkWorkerCallback';
export const SIGNAL = '__haloSdkWorkerSignal';

export interface WorkerSetup {
  /** Absolute file URL of a Node-compatible module exporting setup(options, data). */
  module: string;
  exportName?: string;
  data?: unknown;
}

export interface EncodedOptions {
  options: Record<string, unknown>;
  mcpTools: Array<{ server: string; name: string; description: string; inputSchema: unknown; annotations?: Record<string, unknown>; callback: string }>;
  codeSearch?: string;
  readDenyRoots?: string[];
}

function packSignals(value: unknown, signals: AbortSignal[]): unknown {
  if (value instanceof AbortSignal) { signals.push(value); return { [SIGNAL]: true }; }
  if (Array.isArray(value)) return value.map(item => packSignals(item, signals));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, packSignals(child, signals)]));
}

export function decodeOptions(encoded: EncodedOptions, peer: RpcPeer, scope: string, lifetime: AbortSignal): Options {
  const invoke = async (id: string, args: unknown[]) => {
    const signals: AbortSignal[] = [lifetime];
    const packed = packSignals(args, signals);
    const controller = new AbortController();
    const abort = () => controller.abort();
    for (const signal of signals) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    try { return await peer.request(scope, 'callback', { id, args: packed }, { signal: controller.signal }); }
    finally {
      for (const signal of signals) signal.removeEventListener('abort', abort);
    }
  };
  const decode = (value: unknown): any => {
    if (Array.isArray(value)) return value.map(decode);
    if (!value || typeof value !== 'object') return value;
    if (CALLBACK in value) return (...args: unknown[]) => invoke(String(value[CALLBACK as keyof typeof value]), args);
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, decode(child)]));
  };
  const options: Options = decode(encoded.options);
  if (encoded.readDenyRoots) bindReadDenyFloor(options, encoded.readDenyRoots);
  if (encoded.codeSearch) {
    bindCodeSearchBridge(options, {
      search: request => invoke(encoded.codeSearch!, [request]) as Promise<CodeSearchResult>,
      async dispose() {},
    });
  }
  // Keep SDK server status and tool-pool precedence identical to in-process sessions.
  for (const [name, server] of Object.entries(options.mcpServers ?? {})) {
    if (server.type !== 'sdk') continue;
    const tools = encoded.mcpTools.filter(tool => tool.server === name);
    options.mcpServers![name] = {
      ...server,
      instance: {
        name: server.name, version: '1', tools: [],
        description: server.description, instructions: server.instructions,
        listTools: () => tools.map(tool => ({ name: tool.name, description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown>, annotations: tool.annotations })),
        callTool: async (name: string, input: Record<string, unknown>, extra?: { signal?: AbortSignal }) => {
          const tool = tools.find(tool => tool.name === name);
          if (!tool) throw new Error('Unknown host MCP tool');
          return await invoke(tool.callback, [input, extra?.signal ?? lifetime]) as CallToolResult | undefined;
        },
      },
    };
  }
  return options;
}
