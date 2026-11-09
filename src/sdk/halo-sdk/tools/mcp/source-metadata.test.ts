import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { McpClient } from './client.js';
import { bridgeSdkMcpTools, connectExternalMcpServers, extractSdkMcpTools } from './bridge.js';
import { McpConnectionManager } from './connection-manager.js';
import { createSdkMcpServer, tool } from './sdk-server.js';
import type { McpSdkServerConfigWithInstance } from './sdk-server.js';
import type { McpTransport } from './jsonrpc.js';
import type { ToolContext } from '../../types/tool.js';

const servers: Server[] = [];
const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
const description = 'Full tool description. '.repeat(180);
const schema = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
const context = () => ({ abortSignal: new AbortController().signal }) as ToolContext;

async function endpoint(names = ['lookup/order']) {
  const calls: unknown[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', data => { raw += data; });
    request.on('end', () => {
      const message = JSON.parse(raw);
      if (message.method === 'notifications/initialized') {
        response.writeHead(204); response.end(); return;
      }
      const result = message.method === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: { tools: {} },
          serverInfo: { name: 'Advertised name', version: '1', description: 'Customer records' },
          instructions: 'Use a customer ID for order queries.' }
        : message.method === 'tools/list'
          ? { tools: names.map(name => ({ name, description, inputSchema: schema,
            _meta: { mcpSource: { server: 'forged' }, alwaysLoad: true } })) }
          : (calls.push(message.params), { content: [{ type: 'text', text: 'order found' }] });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, calls };
}

describe('MCP source metadata', () => {
  it('preserves the configured service key and raw tool identity without changing legacy names', async () => {
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'found' }] }));
    const definition = tool('lookup/order', description, schema, handler, { alwaysLoad: true });
    definition._meta = { mcpSource: { server: 'forged', name: 'forged' }, alwaysLoad: true };
    const server = createSdkMcpServer({ name: 'display/name', description: 'Customer records',
      instructions: 'Read first.', tools: [definition] });
    const [bridged] = extractSdkMcpTools({ 'configured/key': server });
    expect(bridged.name).toBe('mcp__display_name__lookup_order');
    expect(bridged.mcpSource).toEqual({ server: 'configured/key', name: 'lookup/order',
      description: 'Customer records', instructions: 'Read first.', toolDescription: description });
    expect(bridged.description.length).toBeLessThan(description.length);
    await bridged.execute({ id: '42' }, context());
    expect(handler).toHaveBeenCalledWith({ id: '42' }, { signal: expect.any(AbortSignal) });
  });

  it('preserves metadata for registered external SDK instances and excludes disabled entries', async () => {
    const handler = vi.fn(async () => ({ content: [{ type: 'text', text: 'found' }] }));
    const server = { type: 'sdk', name: 'server', description: 'Records', instructions: 'Check IDs.',
      instance: { _registeredTools: {
        'lookup/order': { description, inputSchema: schema, handler },
        hidden: { enabled: false, description: 'Hidden', inputSchema: schema, handler },
      } } } as unknown as McpSdkServerConfigWithInstance;
    const tools = extractSdkMcpTools({ configured: server });
    expect(tools).toHaveLength(1);
    expect(tools[0].mcpSource).toEqual({ server: 'configured', name: 'lookup/order',
      description: 'Records', instructions: 'Check IDs.', toolDescription: description });
    await tools[0].execute({ id: '42' }, context());
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each(['bridge', 'manager'] as const)('preserves handshake metadata and original call names through %s', async kind => {
    const { url, calls } = await endpoint();
    let tools;
    if (kind === 'bridge') {
      const connection = await connectExternalMcpServers({ 'configured/key': { type: 'http', url } });
      cleanups.push(connection.disconnect);
      tools = connection.tools;
    } else {
      const manager = new McpConnectionManager();
      cleanups.push(() => manager.disconnectAll());
      manager.addServer('configured/key', { type: 'http', url });
      await manager.connectAll();
      tools = manager.getBridgedTools();
    }
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('mcp__configured_key__lookup_order');
    expect(tools[0].mcpSource).toEqual({ server: 'configured/key', name: 'lookup/order',
      description: 'Customer records', instructions: 'Use a customer ID for order queries.', toolDescription: description });
    expect(tools[0].inputSchema).toEqual(schema);
    expect(tools[0].description).toContain('[truncated]');
    expect(await tools[0].execute({ id: '42' }, context())).toEqual({ content: 'order found', isError: false });
    expect(calls).toEqual([{ name: 'lookup/order', arguments: { id: '42' } }]);
  });

  it('ignores non-text capability metadata and releases it when closed', async () => {
    const transport: McpTransport = {
      connected: true, connect: async () => {}, notify: async () => {}, close: () => {}, setRequestHandler: () => {},
      send: async request => ({ jsonrpc: '2.0', id: request.id, result: {
        serverInfo: { name: 'server', version: '1', description: { invalid: true } }, instructions: ['invalid'],
      } }),
    };
    const client = new McpClient(transport, 'configured');
    await client.initialize();
    expect(client.getServerInfo()).toEqual({ name: 'server', version: '1' });
    expect(client.getInstructions()).toBeUndefined();
    client.close();
    expect(client.getServerInfo()).toBeNull();
  });
});

describe('MCP identity collisions', () => {
  const definition = (name: string) => tool(name, 'Lookup', {}, async () => ({ content: [] }));

  it.each([['lookup/order', 'lookup_order'], ['lookup', 'lookup']])('rejects ambiguous tool names %s and %s', (a, b) => {
    expect(() => bridgeSdkMcpTools(createSdkMcpServer({ name: 'server', tools: [definition(a), definition(b)] })))
      .toThrow('MCP tool identity collision');
  });

  it('rejects ambiguous server identities instead of overwriting a tool', () => {
    expect(() => extractSdkMcpTools({
      a: createSdkMcpServer({ name: 'server/name', tools: [definition('lookup')] }),
      b: createSdkMcpServer({ name: 'server_name', tools: [definition('lookup')] }),
    })).toThrow('MCP tool identity collision');
  });

  it.each(['bridge', 'manager'] as const)('rejects external normalized collisions through %s', async kind => {
    const { url } = await endpoint(['lookup/order', 'lookup_order']);
    if (kind === 'bridge') {
      await expect(connectExternalMcpServers({ server: { type: 'http', url } })).rejects.toThrow('MCP tool identity collision');
    } else {
      const manager = new McpConnectionManager();
      cleanups.push(() => manager.disconnectAll());
      manager.addServer('server', { type: 'http', url });
      await expect(manager.connect('server')).rejects.toThrow('MCP tool identity collision');
      expect(manager.getBridgedTools()).toEqual([]);
    }
  });
});
