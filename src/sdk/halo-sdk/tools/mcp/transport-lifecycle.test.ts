import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpTransport, SSETransport, StdioTransport } from './transports.js';
import type { McpTransport } from './jsonrpc.js';

const servers: Server[] = [];
const transports: McpTransport[] = [];
afterEach(async () => {
  for (const transport of transports.splice(0)) transport.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function listen(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe('MCP transport cancellation', () => {
  it.each(['request', 'notification'] as const)('aborts a stalled HTTP %s on close', async kind => {
    const arrived = deferred<ServerResponse>();
    const url = await listen((_request, response) => arrived.resolve(response));
    const transport = new HttpTransport({ url });
    transports.push(transport);
    await transport.connect();
    const pending = kind === 'request'
      ? transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize' })
      : transport.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const rejected = expect(pending).rejects.toThrow(/closed|abort/i);
    const response = await arrived.promise;
    const disconnected = new Promise<void>(resolve => response.on('close', resolve));
    transport.close();
    await rejected;
    await disconnected;
  });

  it('cancels a stalled HTTP response body, not just the initial request', async () => {
    const arrived = deferred<ServerResponse>();
    const url = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{');
      arrived.resolve(response);
    });
    const transport = new HttpTransport({ url });
    transports.push(transport);
    await transport.connect();
    const pending = transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const rejected = expect(pending).rejects.toThrow(/closed|abort/i);
    const response = await arrived.promise;
    const disconnected = new Promise<void>(resolve => response.on('close', resolve));
    transport.close();
    await rejected;
    await disconnected;
  });

  it('ends SSE preparation immediately when closed before its endpoint arrives', async () => {
    const arrived = deferred<void>();
    const url = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(': connected\n\n');
      arrived.resolve();
    });
    const transport = new SSETransport({ url });
    transports.push(transport);
    const pending = transport.connect();
    const rejected = expect(pending).rejects.toThrow(/closed|abort/i);
    await arrived.promise;
    transport.close();
    await rejected;
    expect(transport.connected).toBe(false);
  });

  it('aborts outstanding SSE POSTs along with its event feed', async () => {
    const posted = deferred<ServerResponse>();
    const url = await listen((request, response) => {
      if (request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('event: endpoint\ndata: /post\n\n');
      } else posted.resolve(response);
    });
    const transport = new SSETransport({ url });
    transports.push(transport);
    await transport.connect();
    const pending = transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const rejected = expect(pending).rejects.toThrow(/closed|abort/i);
    const response = await posted.promise;
    const disconnected = new Promise<void>(resolve => response.on('close', resolve));
    transport.close();
    await rejected;
    await disconnected;
  });

  it('handles the late OS error of a spawn cancelled before its spawn event', async () => {
    const transport = new StdioTransport({ command: join(tmpdir(), randomUUID(), 'missing-command') });
    transports.push(transport);
    const pending = transport.connect();
    const rejected = expect(pending).rejects.toThrow(/closed/i);
    transport.close();
    await rejected;
    await new Promise(resolve => setImmediate(resolve));
  });
});
