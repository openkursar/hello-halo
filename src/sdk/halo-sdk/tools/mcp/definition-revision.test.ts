import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpConnectionManager } from './connection-manager.js';
import { McpClient, type McpToolDefinition } from './client.js';
import { HttpTransport } from './transports.js';
import type { ToolContext } from '../../types/tool.js';

const managers: McpConnectionManager[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.disconnectAll(); vi.restoreAllMocks(); });
const definition = (): McpToolDefinition => ({ name: 'lookup', description: 'Read customer.',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, annotations: { readOnlyHint: true } });
type Snapshot = { tools: McpToolDefinition[]; description: string; instructions: string };
const snapshot = (): Snapshot => ({ tools: [definition()], description: 'Customers', instructions: 'Use IDs.' });
const context = {} as ToolContext;

async function fixture(snapshots: Snapshot[]) {
  const connected = new Set<HttpTransport>();
  const state = new WeakMap<McpClient, Snapshot>();
  let next = 0;
  const connect = vi.spyOn(HttpTransport.prototype, 'connect').mockImplementation(async function () { connected.add(this); });
  vi.spyOn(HttpTransport.prototype, 'close').mockImplementation(function () { connected.delete(this); });
  vi.spyOn(HttpTransport.prototype, 'connected', 'get').mockImplementation(function () { return connected.has(this); });
  vi.spyOn(McpClient.prototype, 'initialize').mockImplementation(async function () { state.set(this, snapshots[next++]); });
  vi.spyOn(McpClient.prototype, 'getTools').mockImplementation(function () { return state.get(this)!.tools; });
  vi.spyOn(McpClient.prototype, 'getServerInfo').mockImplementation(function () { return { name: 'server', version: '1', description: state.get(this)!.description }; });
  vi.spyOn(McpClient.prototype, 'getInstructions').mockImplementation(function () { return state.get(this)!.instructions; });
  const call = vi.spyOn(McpClient.prototype, 'callTool').mockResolvedValue({ content: [{ type: 'text', text: 'found' }] });
  const manager = new McpConnectionManager();
  managers.push(manager);
  manager.addServer('server', { type: 'http', url: 'http://127.0.0.1:1/mcp' });
  await manager.connectAll();
  const [tool] = manager.getBridgedTools();
  return { manager, tool, call, connect, disconnectNextCall: () => call.mockImplementationOnce(async function () {
    this.close();
    throw new Error('Connection lost before result');
  }) };
}

describe('MCP definition revisions', () => {
  it('retries an unchanged definition without changing the published catalog revision', async () => {
    const first = snapshot();
    const reordered = snapshot();
    reordered.tools[0].inputSchema = { required: ['id'], properties: { id: { type: 'string' } }, type: 'object' };
    const { manager, tool, call, disconnectNextCall } = await fixture([first, reordered]);
    const revision = manager.getToolCatalogRevision();
    disconnectNextCall();
    expect(await tool.execute({ id: '42' }, context)).toEqual({ content: 'found', isError: false });
    expect(call).toHaveBeenCalledTimes(2);
    expect(manager.getToolCatalogRevision()).toBe(revision);
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
      const { manager, tool, call, disconnectNextCall } = await fixture([snapshot(), updated]);
      const revision = manager.getToolCatalogRevision();
      disconnectNextCall();
      const result = await tool.execute({ id: '42' }, context);
      expect(result.isError).toBe(true);
      expect(result.content).toContain('not retried under the new definition');
      expect(call).toHaveBeenCalledOnce();
      expect(manager.getToolCatalogRevision()).toBeGreaterThan(revision);
      expect((await tool.execute({ id: '42' }, context)).content).toContain('stale call was not executed');
      expect(call).toHaveBeenCalledOnce();
      if (change !== 'removed') {
        const [fresh] = manager.getBridgedTools();
        expect((await fresh.execute({ id: '42' }, context)).isError).toBe(false);
        expect(call).toHaveBeenCalledTimes(2);
      }
    });

  it('refuses a held tool before execution when a completed restart changed its schema', async () => {
    const updated = snapshot();
    updated.tools[0].inputSchema = { type: 'object', required: ['customer'] };
    const { manager, tool, call } = await fixture([snapshot(), updated]);
    await manager.restart('server');
    expect((await tool.execute({ id: '42' }, context)).isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it('refuses a held tool after its configured server is replaced even with an identical schema', async () => {
    const { manager, tool, call } = await fixture([snapshot(), snapshot()]);
    await manager.setServers({ server: { type: 'http', url: 'http://127.0.0.1:2/mcp' } });
    expect((await tool.execute({ id: '42' }, context)).isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it.each(['disconnect', 'remove'] as const)('does not reconnect an explicitly unavailable held tool after %s', async action => {
    const { manager, tool, call, connect } = await fixture([snapshot()]);
    const revision = manager.getToolCatalogRevision();
    if (action === 'remove') manager.removeServer('server');
    else manager.disconnect('server');
    expect(manager.getToolCatalogRevision()).toBeGreaterThan(revision);
    expect((await tool.execute({ id: '42' }, context)).isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledOnce();
  });

  it('does not serialize a definition again on each tool call', async () => {
    const first = snapshot();
    const { tool, call } = await fixture([first]);
    Object.defineProperty(first.tools[0].inputSchema, 'expensive', { enumerable: true,
      get() { throw new Error('Definition was reserialized on the call path'); } });
    expect((await tool.execute({ id: '42' }, context)).isError).toBe(false);
    expect((await tool.execute({ id: '43' }, context)).isError).toBe(false);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('retains a completed result when a definition changes during an already-running call', async () => {
    const updated = snapshot();
    updated.tools[0].description = 'Updated';
    const { manager, tool, call } = await fixture([snapshot(), updated]);
    let finish!: () => void;
    call.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { content: [{ type: 'text', text: 'Completed before reconnect' }] };
    });
    const pending = tool.execute({ id: '42' }, context);
    await manager.restart('server');
    finish();
    expect(await pending).toEqual({ content: 'Completed before reconnect', isError: false });
    expect(call).toHaveBeenCalledOnce();
  });
});

it('keeps the last definition snapshot visible during an identical reconnect', async () => {
  const { manager, tool, call, disconnectNextCall } = await fixture([snapshot(), snapshot()]);
  const initialize = vi.mocked(McpClient.prototype.initialize);
  const prepare = initialize.getMockImplementation()!;
  let finish!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  initialize.mockImplementationOnce(async function () {
    started();
    await new Promise<void>(resolve => { finish = resolve; });
    return prepare.call(this);
  });
  const revision = manager.getToolCatalogRevision();
  disconnectNextCall();
  const pending = tool.execute({ id: '42' }, context);
  await waiting;
  expect(manager.getToolCatalogRevision()).toBe(revision);
  expect(manager.getBridgedTools()[0].mcpSource).toEqual(tool.mcpSource);
  finish();
  expect((await pending).isError).toBe(false);
  expect(call).toHaveBeenCalledTimes(2);
  expect(manager.getToolCatalogRevision()).toBe(revision);
});

it('publishes removal after failed reconnect and restoration after a later successful handshake', async () => {
  const { manager, tool, disconnectNextCall } = await fixture([snapshot(), snapshot()]);
  vi.mocked(McpClient.prototype.initialize).mockRejectedValueOnce(new Error('Handshake refused'));
  const revision = manager.getToolCatalogRevision();
  disconnectNextCall();
  expect((await tool.execute({ id: '42' }, context)).isError).toBe(true);
  expect(manager.getBridgedTools()).toEqual([]);
  expect(manager.getToolCatalogRevision()).toBeGreaterThan(revision);
  const unavailableRevision = manager.getToolCatalogRevision();
  await manager.connect('server');
  expect(manager.getBridgedTools()).toHaveLength(1);
  expect(manager.getToolCatalogRevision()).toBeGreaterThan(unavailableRevision);
});

it('refuses an ambiguous tool list before an automatic reconnect can replay a call', async () => {
  const changed = snapshot();
  changed.tools.push({ ...changed.tools[0] });
  const { manager, tool, call, disconnectNextCall } = await fixture([snapshot(), changed]);
  disconnectNextCall();
  expect((await tool.execute({ id: '42' }, context)).isError).toBe(true);
  expect(call).toHaveBeenCalledOnce();
  expect(manager.getBridgedTools()).toEqual([]);
});

it('recognizes issued snapshots after removal without claiming unrelated tools', async () => {
  const { manager, tool } = await fixture([snapshot()]);
  expect(manager.ownsTool(tool)).toBe(true);
  expect(manager.ownsTool({ ...tool })).toBe(false);
  manager.removeServer('server');
  expect(manager.ownsTool(tool)).toBe(true);
  expect(manager.getBridgedTools()).toEqual([]);
});
