import { describe, expect, it, vi } from 'vitest';
import { HostCallbacks } from './callbacks.js';
import { decodeOptions } from './options.js';
import { RpcPeer } from './rpc.js';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '../tools/mcp/sdk-server.js';
import { extractSdkMcpTools } from '../tools/mcp/bridge.js';
import type { ToolContext } from '../types/tool.js';

function roundTrip(server: McpSdkServerConfigWithInstance) {
  const signal = new AbortController().signal;
  const callbacks = new HostCallbacks(signal);
  const encoded = structuredClone(callbacks.encode({ mcpServers: { 'configured/key': server } }));
  const host = new RpcPeer(frame => worker.receive(structuredClone(frame)));
  const worker = new RpcPeer(frame => host.receive(structuredClone(frame)));
  host.onRequest = (_method, value, _scope, signal) => callbacks.call(value.id, value.args, signal);
  return { encoded, options: decodeOptions(encoded, worker, 'session', signal), clear: () => callbacks.clear() };
}

describe('worker MCP metadata serialization', () => {
  it('retains service metadata, full tool description, original identity and callback routing', async () => {
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'found' }] }));
    const description = 'Full description. '.repeat(200);
    const server = createSdkMcpServer({ name: 'display/name', description: 'Orders', instructions: 'Use IDs.',
      tools: [tool('lookup/order', description, {}, handler)] });
    const { encoded, options, clear } = roundTrip(server);
    try {
      const [bridged] = extractSdkMcpTools(options.mcpServers);
      expect(encoded.options.mcpServers).toEqual({ 'configured/key': {
        type: 'sdk', name: 'display/name', description: 'Orders', instructions: 'Use IDs.',
      } });
      expect(bridged.mcpSource).toEqual({ server: 'configured/key', name: 'lookup/order',
        description: 'Orders', instructions: 'Use IDs.', toolDescription: description });
      expect(bridged.name).toBe('mcp__display_name__lookup_order');
      expect(await bridged.execute({ id: '42' }, { abortSignal: new AbortController().signal } as ToolContext))
        .toEqual({ content: 'found', isError: false });
      expect(handler).toHaveBeenCalledWith({ id: '42' }, { signal: expect.any(AbortSignal) });
    } finally { clear(); }
  });

  it('preserves metadata for external SDK registered tools without accepting forged source metadata', () => {
    const server = { type: 'sdk', name: 'display', description: 'Orders', instructions: 'Use IDs.',
      instance: { _registeredTools: {
        'lookup/order': { description: 'Look up', inputSchema: {}, handler: async () => ({ content: [] }),
          _meta: { mcpSource: { server: 'forged' }, alwaysLoad: true } },
      } } } as unknown as McpSdkServerConfigWithInstance;
    const { options, clear } = roundTrip(server);
    try {
      expect(extractSdkMcpTools(options.mcpServers)[0].mcpSource).toEqual({ server: 'configured/key', name: 'lookup/order',
        description: 'Orders', instructions: 'Use IDs.', toolDescription: 'Look up' });
    } finally { clear(); }
  });
});
