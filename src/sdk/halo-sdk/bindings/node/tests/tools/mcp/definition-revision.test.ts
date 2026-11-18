import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { McpConnectionManager } from '../../../native/mcp-manager.js';
import type { McpToolDefinition } from '../../../contracts/tools/mcp/client.js';
import type { ToolContext } from '../../../types/tool.js';

const managers: McpConnectionManager[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.disconnectAll();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
const definition = (): McpToolDefinition => ({ name: 'lookup', description: 'Read customer.',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, annotations: { readOnlyHint: true } });
type Snapshot = { tools: McpToolDefinition[]; description: string; instructions: string };
const snapshot = (): Snapshot => ({ tools: [definition()], description: 'Customers', instructions: 'Use IDs.' });
const context = {} as ToolContext;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function fixture(snapshots: Snapshot[]) {
  let next = 0;
  let current = snapshots[0];
  let calls = 0;
  let disconnect = false;
  let failInitialize = false;
  let initializeGate: ReturnType<typeof deferred<void>> | undefined;
  let initializeStarted: ReturnType<typeof deferred<void>> | undefined;
  let callGate: ReturnType<typeof deferred<string>> | undefined;
  let callStarted: ReturnType<typeof deferred<void>> | undefined;
  const reply = (response: ServerResponse, id: unknown, result: unknown) => {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'revision-session' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(204); response.end(); return; }
    let body = '';
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (message.method === 'initialize') {
      initializeStarted?.resolve();
      if (initializeGate) { const gate = initializeGate; initializeGate = undefined; await gate.promise; }
      if (failInitialize) { failInitialize = false; response.writeHead(500); response.end('Handshake refused'); return; }
      current = snapshots[Math.min(next++, snapshots.length - 1)];
      reply(response, message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} },
        serverInfo: { name: 'server', version: '1', description: current.description }, instructions: current.instructions });
    } else if (message.method === 'tools/list') reply(response, message.id, { tools: current.tools });
    else if (message.method === 'tools/call') {
      calls++;
      if (disconnect) { disconnect = false; response.writeHead(404); response.end('Session expired'); return; }
      callStarted?.resolve();
      const gate = callGate;
      callGate = undefined;
      const text = gate ? await gate.promise : 'found';
      reply(response, message.id, { content: [{ type: 'text', text }] });
    } else { response.writeHead(202); response.end(); }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  const manager = new McpConnectionManager();
  managers.push(manager);
  manager.addServer('server', { type: 'http', url });
  await manager.connectAll();
  const [tool] = manager.getBridgedTools();
  return { manager, tool, url, get calls() { return calls; }, get connections() { return next; },
    disconnectNextCall: () => { disconnect = true; },
    failNextInitialize: () => { failInitialize = true; },
    holdInitialize: () => {
      initializeGate = deferred<void>(); initializeStarted = deferred<void>();
      return { started: initializeStarted.promise, finish: initializeGate.resolve };
    },
    holdCall: () => {
      callGate = deferred<string>(); callStarted = deferred<void>();
      return { started: callStarted.promise, finish: callGate.resolve };
    },
  };
}

describe('MCP definition revisions', () => {
  it('retries an unchanged definition without changing the published catalog revision', async () => {
    const reordered = snapshot();
    reordered.tools[0].inputSchema = { required: ['id'], properties: { id: { type: 'string' } }, type: 'object' };
    const f = await fixture([snapshot(), reordered]);
    const revision = f.manager.getToolCatalogRevision();
    f.disconnectNextCall();
    expect(await f.tool.execute({ id: '42' }, context)).toEqual({ content: 'found', isError: false });
    expect(f.calls).toBe(2);
    expect(f.manager.getToolCatalogRevision()).toBe(revision);
  });

  it.each(['schema', 'description', 'instructions', 'service-description', 'annotations', 'removed'] as const)
    ('does not replay a stale call after reconnect changes %s', async change => {
      const updated = snapshot();
      if (change === 'schema') updated.tools[0].inputSchema = { type: 'object', required: ['customer'] };
      else if (change === 'description') updated.tools[0].description = 'A different operation.';
      else if (change === 'instructions') updated.instructions = 'New required instructions.';
      else if (change === 'service-description') updated.description = 'Different service purpose.';
      else if (change === 'annotations') updated.tools[0].annotations = { readOnlyHint: false };
      else updated.tools = [];
      const f = await fixture([snapshot(), updated]);
      const revision = f.manager.getToolCatalogRevision();
      f.disconnectNextCall();
      const result = await f.tool.execute({ id: '42' }, context);
      expect(result.isError).toBe(true);
      expect(result.content).toContain('not retried under the new definition');
      expect(f.calls).toBe(1);
      expect(f.manager.getToolCatalogRevision()).toBeGreaterThan(revision);
      expect((await f.tool.execute({ id: '42' }, context)).content).toContain('stale call was not executed');
      expect(f.calls).toBe(1);
      if (change !== 'removed') {
        expect((await f.manager.getBridgedTools()[0].execute({ id: '42' }, context)).isError).toBe(false);
        expect(f.calls).toBe(2);
      }
    });

  it('refuses a held tool before execution when a completed restart changed its schema', async () => {
    const updated = snapshot();
    updated.tools[0].inputSchema = { type: 'object', required: ['customer'] };
    const f = await fixture([snapshot(), updated]);
    await f.manager.restart('server');
    expect((await f.tool.execute({ id: '42' }, context)).isError).toBe(true);
    expect(f.calls).toBe(0);
  });

  it('refuses a held tool after its configured server is replaced even with an identical schema', async () => {
    const f = await fixture([snapshot()]);
    const replacement = await fixture([snapshot()]);
    await f.manager.setServers({ server: { type: 'http', url: replacement.url } });
    expect((await f.tool.execute({ id: '42' }, context)).isError).toBe(true);
    expect(f.calls).toBe(0);
    expect(replacement.calls).toBe(0);
  });

  it.each(['disconnect', 'remove'] as const)('does not reconnect an explicitly unavailable held tool after %s', async action => {
    const f = await fixture([snapshot()]);
    const revision = f.manager.getToolCatalogRevision();
    if (action === 'remove') f.manager.removeServer('server');
    else f.manager.disconnect('server');
    expect(f.manager.getToolCatalogRevision()).toBeGreaterThan(revision);
    expect((await f.tool.execute({ id: '42' }, context)).isError).toBe(true);
    expect(f.calls).toBe(0);
    expect(f.connections).toBe(1);
  });

  it('does not serialize a definition again on each tool call', async () => {
    const f = await fixture([snapshot()]);
    Object.defineProperty(f.tool.inputSchema, 'expensive', { enumerable: true,
      get() { throw new Error('Definition was reserialized on the call path'); } });
    expect((await f.tool.execute({ id: '42' }, context)).isError).toBe(false);
    expect((await f.tool.execute({ id: '43' }, context)).isError).toBe(false);
    expect(f.calls).toBe(2);
  });

  it('does not replay an HTTP call whose transport is closed by a definition-changing restart', async () => {
    const updated = snapshot(); updated.tools[0].description = 'Updated';
    const f = await fixture([snapshot(), updated]);
    const gate = f.holdCall();
    const pending = f.tool.execute({ id: '42' }, context);
    await gate.started;
    await f.manager.restart('server');
    gate.finish('Completed before reconnect');
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content).toContain('closed');
    expect(f.calls).toBe(1);
  });

  it('keeps the last definition snapshot visible during an identical reconnect', async () => {
    const f = await fixture([snapshot(), snapshot()]);
    const gate = f.holdInitialize();
    const revision = f.manager.getToolCatalogRevision();
    f.disconnectNextCall();
    const pending = f.tool.execute({ id: '42' }, context);
    await gate.started;
    expect(f.manager.getToolCatalogRevision()).toBe(revision);
    expect(f.manager.getBridgedTools()[0].mcpSource).toEqual(f.tool.mcpSource);
    gate.finish();
    expect((await pending).isError).toBe(false);
    expect(f.calls).toBe(2);
    expect(f.manager.getToolCatalogRevision()).toBe(revision);
  });

  it('publishes removal after failed reconnect and restoration after a later successful handshake', async () => {
    const f = await fixture([snapshot(), snapshot()]);
    f.failNextInitialize();
    const revision = f.manager.getToolCatalogRevision();
    f.disconnectNextCall();
    expect((await f.tool.execute({ id: '42' }, context)).isError).toBe(true);
    expect(f.manager.getBridgedTools()).toEqual([]);
    expect(f.manager.getToolCatalogRevision()).toBeGreaterThan(revision);
    const unavailableRevision = f.manager.getToolCatalogRevision();
    await f.manager.connect('server');
    expect(f.manager.getBridgedTools()).toHaveLength(1);
    expect(f.manager.getToolCatalogRevision()).toBeGreaterThan(unavailableRevision);
  });

  it('refuses an ambiguous tool list before an automatic reconnect can replay a call', async () => {
    const changed = snapshot(); changed.tools.push({ ...changed.tools[0] });
    const f = await fixture([snapshot(), changed]);
    f.disconnectNextCall();
    expect((await f.tool.execute({ id: '42' }, context)).isError).toBe(true);
    expect(f.calls).toBe(1);
    expect(f.manager.getBridgedTools()).toEqual([]);
  });

  it('recognizes issued snapshots after removal without claiming unrelated tools', async () => {
    const { manager, tool } = await fixture([snapshot()]);
    expect(manager.ownsTool(tool)).toBe(true);
    expect(manager.ownsTool({ ...tool })).toBe(false);
    manager.removeServer('server');
    expect(manager.ownsTool(tool)).toBe(true);
    expect(manager.getBridgedTools()).toEqual([]);
  });
});
