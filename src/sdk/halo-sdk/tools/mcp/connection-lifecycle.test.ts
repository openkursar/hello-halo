import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpConnectionManager } from './connection-manager.js';
import { McpClient } from './client.js';
import { HttpTransport } from './transports.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const managers: McpConnectionManager[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.disconnectAll(); vi.restoreAllMocks(); });

function manager() {
  const result = new McpConnectionManager();
  result.addServer('server', { type: 'http', url: 'http://127.0.0.1:1/mcp' });
  managers.push(result);
  vi.spyOn(McpClient.prototype, 'initialize').mockResolvedValue(undefined);
  return result;
}

describe('MCP connection ownership', () => {
  it('does not publish a connection that finishes after disposal', async () => {
    const pending = deferred();
    vi.spyOn(HttpTransport.prototype, 'connect').mockReturnValue(pending.promise);
    const close = vi.spyOn(HttpTransport.prototype, 'close').mockImplementation(() => {});
    const current = manager();
    const connecting = current.connect('server');
    const rejected = expect(connecting).rejects.toThrow(/closed|cancel|supersed/i);
    current.disconnectAll();
    pending.resolve();
    await rejected;
    expect(current.isConnected('server')).toBe(false);
    expect(close).toHaveBeenCalled();
  });

  it('closes the transport when initialization fails', async () => {
    vi.spyOn(HttpTransport.prototype, 'connect').mockResolvedValue(undefined);
    const close = vi.spyOn(HttpTransport.prototype, 'close').mockImplementation(() => {});
    const current = manager();
    vi.mocked(McpClient.prototype.initialize).mockRejectedValue(new Error('initialize failed'));
    await expect(current.connect('server')).rejects.toThrow('initialize failed');
    expect(close).toHaveBeenCalledOnce();
    expect(current.isConnected('server')).toBe(false);
  });

  it('shares concurrent connection preparation', async () => {
    const pending = deferred();
    const connect = vi.spyOn(HttpTransport.prototype, 'connect').mockReturnValue(pending.promise);
    vi.spyOn(HttpTransport.prototype, 'close').mockImplementation(() => {});
    const current = manager();
    const first = current.connect('server');
    const second = current.connect('server');
    pending.resolve();
    await Promise.all([first, second]);
    expect(connect).toHaveBeenCalledOnce();
  });

  it('keeps a replacement connection when an obsolete attempt later fails', async () => {
    const old = deferred();
    vi.spyOn(HttpTransport.prototype, 'connect').mockReturnValueOnce(old.promise).mockResolvedValue(undefined);
    vi.spyOn(HttpTransport.prototype, 'close').mockImplementation(() => {});
    const current = manager();
    const previous = current.connect('server').catch(error => error);
    await current.restart('server');
    expect(current.isConnected('server')).toBe(true);
    old.reject(new Error('obsolete connection failed'));
    await previous;
    expect(current.isConnected('server')).toBe(true);
  });

  it('refuses new connections after disposal', async () => {
    const connect = vi.spyOn(HttpTransport.prototype, 'connect').mockResolvedValue(undefined);
    const current = manager();
    current.disconnectAll();
    await expect(current.connect('server')).rejects.toThrow(/closed|disposed/i);
    expect(connect).not.toHaveBeenCalled();
  });

  it('does not reconnect a server disabled while its tool call was pending', async () => {
    const connect = vi.spyOn(HttpTransport.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(HttpTransport.prototype, 'close').mockImplementation(() => {});
    vi.spyOn(McpClient.prototype, 'getTools').mockReturnValue([{ name: 'task', description: 'Task', inputSchema: {} }]);
    const pending = deferred();
    vi.spyOn(McpClient.prototype, 'callTool').mockImplementation(async () => { await pending.promise; throw new Error('connection lost'); });
    const current = manager();
    await current.connect('server');
    const call = current.getBridgedTools()[0].execute({}, {} as never);
    current.disconnect('server');
    pending.resolve();
    expect((await call).isError).toBe(true);
    expect(connect).toHaveBeenCalledOnce();
    expect(current.isConnected('server')).toBe(false);
  });
});
