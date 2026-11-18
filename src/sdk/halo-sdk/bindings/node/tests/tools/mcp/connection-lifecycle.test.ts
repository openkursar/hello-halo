import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { McpConnectionManager } from '../../../native/mcp-manager.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const managers: McpConnectionManager[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.disconnectAll();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

async function fixture() {
  const arrived = deferred<ServerResponse>();
  const called = deferred<ServerResponse>();
  let initializations = 0;
  let hold = true;
  let fail = false;
  const reply = (response: ServerResponse, result: unknown, id: unknown) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };
  const ids = new WeakMap<ServerResponse, unknown>();
  const initialized = (response: ServerResponse) => reply(response,
    { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }, ids.get(response));
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(204); response.end(); return; }
    let body = '';
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    ids.set(response, message.id);
    if (message.method === 'initialize') {
      initializations++;
      if (fail) { response.writeHead(500); response.end('initialize failed'); }
      else if (hold) { hold = false; arrived.resolve(response); }
      else initialized(response);
    } else if (message.method === 'tools/list') reply(response, { tools: [{ name: 'task', description: 'Task', inputSchema: {} }] }, message.id);
    else if (message.method === 'tools/call') called.resolve(response);
    else { response.writeHead(202); response.end(); }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const manager = new McpConnectionManager();
  manager.addServer('server', { type: 'http', url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp` });
  managers.push(manager);
  return { manager, arrived: arrived.promise, called: called.promise, initialized,
    get initializations() { return initializations; }, failInitialize: () => { fail = true; } };
}

describe('MCP connection ownership', () => {
  it('does not publish a connection that finishes after disposal', async () => {
    const f = await fixture();
    const connecting = f.manager.connect('server');
    const rejected = expect(connecting).rejects.toThrow(/closed|cancel|supersed/i);
    const response = await f.arrived;
    const closed = new Promise<void>(resolve => response.on('close', resolve));
    f.manager.disconnectAll();
    await rejected;
    await closed;
    f.initialized(response);
    expect(f.manager.isConnected('server')).toBe(false);
  });

  it('closes the transport when initialization fails', async () => {
    const f = await fixture();
    f.failInitialize();
    await expect(f.manager.connect('server')).rejects.toThrow(/500|initialize failed/i);
    expect(f.manager.isConnected('server')).toBe(false);
    expect(f.manager.getBridgedTools()).toEqual([]);
  });

  it('shares concurrent connection preparation', async () => {
    const f = await fixture();
    const first = f.manager.connect('server');
    const second = f.manager.connect('server');
    f.initialized(await f.arrived);
    await Promise.all([first, second]);
    expect(f.initializations).toBe(1);
    expect(f.manager.isConnected('server')).toBe(true);
  });

  it.each(['failure', 'success'] as const)('keeps a replacement connection when an obsolete attempt later reports %s', async outcome => {
    const f = await fixture();
    const previous = f.manager.connect('server').catch(error => error);
    const response = await f.arrived;
    await f.manager.restart('server');
    expect(f.manager.isConnected('server')).toBe(true);
    if (outcome === 'success') f.initialized(response);
    else { response.writeHead(500); response.end('obsolete connection failed'); }
    await previous;
    expect(f.manager.isConnected('server')).toBe(true);
    expect(f.manager.getBridgedTools()).toHaveLength(1);
    expect(f.initializations).toBe(2);
  });

  it('refuses new connections after disposal', async () => {
    const f = await fixture();
    f.manager.disconnectAll();
    await expect(f.manager.connect('server')).rejects.toThrow(/closed|disposed/i);
    expect(f.initializations).toBe(0);
  });

  it('does not reconnect a server disabled while its tool call was pending', async () => {
    const f = await fixture();
    const connecting = f.manager.connect('server');
    f.initialized(await f.arrived);
    await connecting;
    const call = f.manager.getBridgedTools()[0].execute({}, {} as never);
    const response = await f.called;
    f.manager.disconnect('server');
    response.writeHead(404); response.end('connection lost');
    expect((await call).isError).toBe(true);
    expect(f.initializations).toBe(1);
    expect(f.manager.isConnected('server')).toBe(false);
  });
});
