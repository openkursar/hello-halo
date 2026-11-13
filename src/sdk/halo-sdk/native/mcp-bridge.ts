import type { Tool, ToolContext, ToolResult } from '../types/tool.js';
import type { McpSdkServerConfigWithInstance, SdkMcpServerInstance } from '../tools/mcp/sdk-server.js';
import { zodToJsonSchema } from '../tools/mcp/zod-to-json-schema.js';
import { createHostCallbacks } from './host-callbacks.js';
import { loadBinding, nativeError } from './binding.js';
import { registerMcpTool, type McpToolRegistration } from './mcp-tool-identities.js';
import { decodeWire, encodeWire } from './wire.js';
export { McpToolIdentityError } from './mcp-errors.js';
export type { ExternalMcpConnection, McpServerConnectionStatus } from '../tools/mcp/bridge.js';

function value<T>(method: string, args: unknown[]): T {
  try { return decodeWire(JSON.parse(loadBinding().mcpBridgeValue(method, JSON.stringify(encodeWire(args))))) as T; }
  catch (error) { throw nativeError(error); }
}
export function assertUniqueMcpToolNames(tools: readonly Tool[]): void { value('assertUnique', [tools.map(tool => ({ name: tool.name }))]); }
export function isSdkMcpServerConfig(config: unknown): config is McpSdkServerConfigWithInstance {
  if (!config || typeof config !== 'object') return false;
  const object = config as Record<string, unknown>; return object.type === 'sdk' && 'instance' in object && object.instance != null;
}
export function bridgeSdkMcpTools(server: { name: string; instance: unknown; description?: string; instructions?: string }, sourceServer = server.name): Tool[] {
  const instance = server.instance as SdkMcpServerInstance & { _registeredTools?: Record<string, any> };
  const metadata = { name: server.name, description: server.description, instructions: server.instructions,
    instanceDescription: undefined as unknown, instanceInstructions: undefined as unknown };
  if (metadata.description == null) metadata.instanceDescription = instance.description;
  if (metadata.instructions == null) metadata.instanceInstructions = instance.instructions;
  const listed = typeof instance.listTools === 'function';
  const registered = !listed && instance._registeredTools && typeof instance._registeredTools === 'object' ? Object.entries(instance._registeredTools).filter(([, definition]) => definition?.enabled !== false) : [];
  if (!listed && !registered.length) return [];
  const definitions = listed ? instance.listTools() : registered.map(([name, definition]) => ({ name, description: definition.description ?? '',
    inputSchema: zodToJsonSchema(definition.inputSchema) }));
  const descriptors = value<Record<string, any>[]>('descriptors', [metadata, sourceServer,
    definitions.map(definition => ({ name: definition.name, description: definition.description })), listed ? 'sdk' : 'registered']);
  return descriptors.map(descriptor => {
    const index = descriptor.nativeMcp.index as number, definition = definitions[index];
    const registration: McpToolRegistration = { descriptor, invoke: (input, signal) => listed
      ? instance.callTool(definition.name, input, { signal }) : registered[index][1].handler(input, { signal }) };
    const descriptorWire = JSON.stringify(encodeWire(descriptor));
    const { nativeMcp: _nativeMcp, concurrencySafe: _concurrencySafe, ...publicDescriptor } = descriptor;
    const tool: Tool = { ...publicDescriptor, inputSchema: definition.inputSchema,
      isConcurrencySafe: () => (listed ? (definition as { annotations?: { readOnlyHint?: boolean } }).annotations : registered[index][1].annotations)?.readOnlyHint === true,
      async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
        const results = new Map<string, unknown>();
        const callbacks = createHostCallbacks((kind, frame) => {
          if (kind === 'cancel') return undefined;
          if (kind !== 'call' || frame.method !== 'mcp.public.call') throw new Error('Unknown public MCP tool callback');
          return Promise.resolve(registration.invoke(input, context.abortSignal)).then(result => {
            results.set('result', result);
            return { reference: 'result' };
          });
        }, { errorMode: 'opaque' });
        try {
          let receipt: { reference: string };
          try { receipt = decodeWire(JSON.parse(await loadBinding().mcpBridgeInvoke(descriptorWire,
            JSON.stringify(encodeWire(undefined)), callbacks.callback))) as { reference: string }; }
          catch (error) { throw callbacks.error(error); }
          if (!results.has(receipt.reference)) throw new Error('MCP result reference is no longer available');
          return loadBinding().mcpBridgeFormat(descriptorWire, results.get(receipt.reference)) as ToolResult;
        } catch (error) {
          if (listed) throw error;
          const message = error instanceof Error ? error.message : String(error);
          return value<ToolResult>('handlerFailure', [descriptor, `${message}`]);
        } finally { callbacks.release(); results.clear(); }
      },
    } as unknown as Tool;
    registerMcpTool(tool, registration); return tool;
  });
}
export function extractSdkMcpTools(servers: Record<string, unknown> | undefined): Tool[] {
  if (!servers) return [];
  const tools = Object.entries(servers).flatMap(([name, server]) => isSdkMcpServerConfig(server) ? bridgeSdkMcpTools(server, name) : []);
  assertUniqueMcpToolNames(tools); return tools;
}
