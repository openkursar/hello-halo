/**
 * Unit tests for McpConnectionManager — focuses on dynamic management:
 * addServer, removeServer, toggle, setServers, and state queries.
 *
 * Connection effects use isolated local MCP endpoints.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { McpConnectionManager } from '../../../native/mcp-manager.js';
import { bridgeSdkMcpTools } from '../../../native/mcp-bridge.js';

function truncateDescription(description: string): string {
  return bridgeSdkMcpTools({ name: 'budget', instance: {
    listTools: () => [{ name: 'tool', description, inputSchema: {} }],
  } })[0].description;
}

describe('shared MCP description budget', () => {
  it('keeps the existing boundary and omission suffix', () => {
    expect(truncateDescription('')).toBe('');
    expect(truncateDescription('a'.repeat(2048))).toBe('a'.repeat(2048));
    expect(truncateDescription('a'.repeat(2049))).toBe('a'.repeat(2048) + '... [truncated]');
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const managers: McpConnectionManager[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) { manager.disconnectAll(); await manager.whenSettled(); }
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

async function endpoint(failure?: string) {
  let initializations = 0;
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', data => { raw += data; });
    request.on('end', () => {
      const message = JSON.parse(raw);
      if (!message.id) { response.writeHead(204); response.end(); return; }
      if (message.method === 'initialize') initializations++;
      const result = message.method === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : { tools: [] };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id,
        ...(failure ? { error: { code: -32603, message: failure } } : { result }) }));
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { config: { type: 'http', url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp` },
    initializations: () => initializations };
}

/** Make a manager with two pre-registered servers (not connected). */
function makeManager(): McpConnectionManager {
  const mgr = new McpConnectionManager();
  managers.push(mgr);
  mgr.addServer('alpha', { type: 'stdio', command: 'alpha-mcp' });
  mgr.addServer('beta', { type: 'stdio', command: 'beta-mcp' });
  return mgr;
}

// ---------------------------------------------------------------------------
// addServer
// ---------------------------------------------------------------------------

describe('addServer', () => {
  it('registers a new server', () => {
    const mgr = new McpConnectionManager();
  managers.push(mgr);
    mgr.addServer('s1', { type: 'stdio', command: 'cmd' });
    expect(mgr.serverNames()).toContain('s1');
  });

  it('is idempotent — second call with same name is a no-op', () => {
    const mgr = new McpConnectionManager();
  managers.push(mgr);
    mgr.addServer('s1', { type: 'stdio', command: 'cmd-a' });
    mgr.addServer('s1', { type: 'stdio', command: 'cmd-b' });
    // The config from the second call must not override the first
    expect(mgr.serverNames()).toHaveLength(1);
  });

  it('starts with disconnected status', () => {
    const mgr = new McpConnectionManager();
  managers.push(mgr);
    mgr.addServer('s1', { type: 'stdio', command: 'cmd' });
    expect(mgr.isConnected('s1')).toBe(false);
    expect(mgr.getStatus('s1')?.state).toBe('disconnected');
  });
});

// ---------------------------------------------------------------------------
// removeServer
// ---------------------------------------------------------------------------

describe('removeServer', () => {
  it('deregisters a server', () => {
    const mgr = makeManager();
    mgr.removeServer('alpha');
    expect(mgr.serverNames()).not.toContain('alpha');
    expect(mgr.serverNames()).toContain('beta');
  });

  it('is a no-op for an unknown server', () => {
    const mgr = makeManager();
    expect(() => mgr.removeServer('nonexistent')).not.toThrow();
    expect(mgr.serverNames()).toHaveLength(2);
  });

  it('disconnects before removal', async () => {
    const fixture = await endpoint();
    const mgr = makeManager();
    mgr.addServer('connected', fixture.config);
    await mgr.connect('connected');
    expect(mgr.isConnected('connected')).toBe(true);
    mgr.removeServer('connected');
    await mgr.whenSettled();
    expect(mgr.isConnected('connected')).toBe(false);
    expect(mgr.serverNames()).not.toContain('connected');
  });
});

// ---------------------------------------------------------------------------
// serverNames / isConnected / getStatus / getAllStatuses
// ---------------------------------------------------------------------------

describe('serverNames', () => {
  it('returns all registered server names', () => {
    const mgr = makeManager();
    expect(mgr.serverNames().sort()).toEqual(['alpha', 'beta']);
  });

  it('returns empty array when no servers registered', () => {
    const mgr = new McpConnectionManager();
  managers.push(mgr);
    expect(mgr.serverNames()).toHaveLength(0);
  });
});

describe('isConnected', () => {
  it('returns false for unconnected server', () => {
    const mgr = makeManager();
    expect(mgr.isConnected('alpha')).toBe(false);
  });

  it('returns false for unknown server', () => {
    const mgr = makeManager();
    expect(mgr.isConnected('unknown')).toBe(false);
  });
});

describe('getStatus', () => {
  it('returns status for registered server', () => {
    const mgr = makeManager();
    const status = mgr.getStatus('alpha');
    expect(status).toBeDefined();
    expect(status?.state).toBe('disconnected');
  });

  it('returns undefined for unknown server', () => {
    const mgr = new McpConnectionManager();
  managers.push(mgr);
    expect(mgr.getStatus('ghost')).toBeUndefined();
  });
});

describe('getAllStatuses', () => {
  it('returns a map with an entry per registered server', () => {
    const mgr = makeManager();
    const map = mgr.getAllStatuses();
    expect(map.size).toBe(2);
    expect(map.has('alpha')).toBe(true);
    expect(map.has('beta')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// toggle
// ---------------------------------------------------------------------------

describe('toggle', () => {
  it('throws for unknown server', async () => {
    const mgr = makeManager();
    await expect(mgr.toggle('ghost', true)).rejects.toThrow('"ghost" is not registered');
  });

  it('toggle(name, false) disconnects an active server', async () => {
    const fixture = await endpoint();
    const mgr = makeManager();
    mgr.addServer('connected', fixture.config);
    await mgr.connect('connected');
    expect(mgr.isConnected('connected')).toBe(true);
    await mgr.toggle('connected', false);
    expect(mgr.isConnected('connected')).toBe(false);
    expect(fixture.initializations()).toBe(1);
  });

  it('toggle(name, false) leaves server registered but disconnected', async () => {
    const mgr = makeManager();
    await mgr.toggle('alpha', false);
    expect(mgr.serverNames()).toContain('alpha');
    expect(mgr.isConnected('alpha')).toBe(false);
  });

  it('toggle(name, true) on already-connected server is a no-op', async () => {
    const mgr = makeManager();
    const fixture = await endpoint();
    mgr.addServer('connected', fixture.config);
    await mgr.toggle('connected', true);
    expect(mgr.isConnected('connected')).toBe(true);
    await mgr.toggle('connected', true);
    expect(fixture.initializations()).toBe(1);
    await mgr.toggle('connected', false);
    await mgr.toggle('connected', true);
    expect(mgr.isConnected('connected')).toBe(true);
    expect(fixture.initializations()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// setServers
// ---------------------------------------------------------------------------

describe('setServers', () => {
  it('returns removed list for servers not in new config', async () => {
    const mgr = makeManager();
    // alpha and beta present; new config only has alpha
    const { added, removed } = await mgr.setServers({
      alpha: { type: 'stdio', command: 'alpha-mcp' },
    });
    expect(removed).toContain('beta');
    expect(added).not.toContain('alpha'); // unchanged
    expect(mgr.serverNames()).not.toContain('beta');
  });

  it('returns added list for new servers', async () => {
    const mgr = makeManager();
    const fixture = await endpoint();
    const { added, removed } = await mgr.setServers({
      alpha: { type: 'stdio', command: 'alpha-mcp' },
      beta: { type: 'stdio', command: 'beta-mcp' },
      gamma: fixture.config,
    });
    expect(added).toContain('gamma');
    expect(removed).toHaveLength(0);
    expect(fixture.initializations()).toBe(1);
    expect(mgr.isConnected('gamma')).toBe(true);
  });

  it('restarts server when config changes', async () => {
    const mgr = makeManager();
    const first = await endpoint();
    const replacement = await endpoint();
    const beta = await endpoint();
    await mgr.setServers({ alpha: first.config, beta: beta.config });
    await mgr.setServers({ alpha: replacement.config, beta: beta.config });
    expect(first.initializations()).toBe(1);
    expect(replacement.initializations()).toBe(1);
    expect(beta.initializations()).toBe(1);
    expect(mgr.isConnected('alpha')).toBe(true);
    expect(mgr.isConnected('beta')).toBe(true);
  });

  it('leaves unchanged servers untouched', async () => {
    const mgr = makeManager();
    const alpha = await endpoint();
    const beta = await endpoint();
    const configs = { alpha: alpha.config, beta: beta.config };
    await mgr.setServers(configs);
    const before = mgr.getToolCatalogRevision();
    await mgr.setServers(configs);
    expect(alpha.initializations()).toBe(1);
    expect(beta.initializations()).toBe(1);
    expect(mgr.getToolCatalogRevision()).toBe(before);
  });

  it('records errors from failed connect', async () => {
    const mgr = makeManager();
    const fixture = await endpoint('connection refused');
    const { errors } = await mgr.setServers({
      alpha: { type: 'stdio', command: 'alpha-mcp' },
      gamma: fixture.config,
    });
    expect(errors.gamma).toContain('connection refused');
  });

  it('handles empty new config (removes all)', async () => {
    const mgr = makeManager();
    const { removed, added } = await mgr.setServers({});
    expect(removed.sort()).toEqual(['alpha', 'beta']);
    expect(added).toHaveLength(0);
    expect(mgr.serverNames()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getStatuses / getBridgedTools
// ---------------------------------------------------------------------------

describe('getStatuses', () => {
  it('returns all registered servers with failed status when disconnected', () => {
    const mgr = makeManager();
    const statuses = mgr.getStatuses();
    expect(statuses).toHaveLength(2);
    for (const s of statuses) {
      expect(s.status).toBe('failed');
    }
  });

  it('returns empty array for empty manager', () => {
    const mgr = new McpConnectionManager();
  managers.push(mgr);
    expect(mgr.getStatuses()).toHaveLength(0);
  });
});

describe('getBridgedTools', () => {
  it('returns empty array when no servers are connected', () => {
    const mgr = makeManager();
    expect(mgr.getBridgedTools()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// disconnectAll
// ---------------------------------------------------------------------------

describe('disconnectAll', () => {
  it('disconnects all servers and marks manager as disposed', async () => {
    const mgr = makeManager();
    const alpha = await endpoint();
    const beta = await endpoint();
    await mgr.setServers({ alpha: alpha.config, beta: beta.config });
    expect(mgr.isConnected('alpha')).toBe(true);
    expect(mgr.isConnected('beta')).toBe(true);
    mgr.disconnectAll();
    await mgr.whenSettled();
    expect(mgr.isConnected('alpha')).toBe(false);
    expect(mgr.isConnected('beta')).toBe(false);
    await expect(mgr.connect('alpha')).rejects.toThrow(/closed|disposed/i);
    expect(alpha.initializations()).toBe(1);
    expect(beta.initializations()).toBe(1);
  });

  it('post-disconnectAll: all servers are disconnected', () => {
    const mgr = makeManager();
    mgr.disconnectAll();
    for (const name of mgr.serverNames()) {
      expect(mgr.isConnected(name)).toBe(false);
    }
  });
});
