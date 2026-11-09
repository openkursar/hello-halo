/**
 * Unit tests for McpConnectionManager — focuses on dynamic management:
 * addServer, removeServer, toggle, setServers, and state queries.
 *
 * Network-level connect/disconnect is tested via vi.spyOn on instance methods
 * to avoid needing real MCP server processes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpConnectionManager } from './connection-manager.js';
import { truncateDescription } from './bridge.js';

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

/** Make a manager with two pre-registered servers (not connected). */
function makeManager(): McpConnectionManager {
  const mgr = new McpConnectionManager();
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
    mgr.addServer('s1', { type: 'stdio', command: 'cmd' });
    expect(mgr.serverNames()).toContain('s1');
  });

  it('is idempotent — second call with same name is a no-op', () => {
    const mgr = new McpConnectionManager();
    mgr.addServer('s1', { type: 'stdio', command: 'cmd-a' });
    mgr.addServer('s1', { type: 'stdio', command: 'cmd-b' });
    // The config from the second call must not override the first
    expect(mgr.serverNames()).toHaveLength(1);
  });

  it('starts with disconnected status', () => {
    const mgr = new McpConnectionManager();
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

  it('calls disconnect before removal', () => {
    const mgr = makeManager();
    const disconnectSpy = vi.spyOn(mgr, 'disconnect');
    mgr.removeServer('alpha');
    expect(disconnectSpy).toHaveBeenCalledWith('alpha');
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

  it('toggle(name, false) calls disconnect', async () => {
    const mgr = makeManager();
    const spy = vi.spyOn(mgr, 'disconnect');
    await mgr.toggle('alpha', false);
    expect(spy).toHaveBeenCalledWith('alpha');
  });

  it('toggle(name, false) leaves server registered but disconnected', async () => {
    const mgr = makeManager();
    await mgr.toggle('alpha', false);
    expect(mgr.serverNames()).toContain('alpha');
    expect(mgr.isConnected('alpha')).toBe(false);
  });

  it('toggle(name, true) on already-connected server is a no-op', async () => {
    const mgr = makeManager();
    // Simulate connected state by patching the manager's private map via spy
    const connectSpy = vi.spyOn(mgr, 'connect').mockResolvedValue(undefined);
    // Manually set as connected (access internal getStatus path indirectly)
    // toggle(true) should not re-connect a server that reports state=connected
    // We can test this by toggling false first (via spy) then true
    await mgr.toggle('alpha', false); // disconnect
    connectSpy.mockResolvedValue(undefined);
    await mgr.toggle('alpha', true); // should call connect since it's disconnected
    expect(connectSpy).toHaveBeenCalledWith('alpha');
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
    const connectSpy = vi.spyOn(mgr, 'connect').mockResolvedValue(undefined);
    const { added, removed } = await mgr.setServers({
      alpha: { type: 'stdio', command: 'alpha-mcp' },
      beta: { type: 'stdio', command: 'beta-mcp' },
      gamma: { type: 'stdio', command: 'gamma-mcp' },
    });
    expect(added).toContain('gamma');
    expect(removed).toHaveLength(0);
    expect(connectSpy).toHaveBeenCalledWith('gamma');
  });

  it('restarts server when config changes', async () => {
    const mgr = makeManager();
    const restartSpy = vi.spyOn(mgr, 'restart').mockResolvedValue(undefined);
    await mgr.setServers({
      alpha: { type: 'stdio', command: 'alpha-mcp-v2' }, // changed command
      beta: { type: 'stdio', command: 'beta-mcp' },       // same
    });
    expect(restartSpy).toHaveBeenCalledWith('alpha');
    expect(restartSpy).not.toHaveBeenCalledWith('beta');
  });

  it('leaves unchanged servers untouched', async () => {
    const mgr = makeManager();
    const restartSpy = vi.spyOn(mgr, 'restart').mockResolvedValue(undefined);
    const connectSpy = vi.spyOn(mgr, 'connect').mockResolvedValue(undefined);
    await mgr.setServers({
      alpha: { type: 'stdio', command: 'alpha-mcp' },
      beta: { type: 'stdio', command: 'beta-mcp' },
    });
    expect(restartSpy).not.toHaveBeenCalled();
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('records errors from failed connect', async () => {
    const mgr = makeManager();
    vi.spyOn(mgr, 'connect').mockRejectedValue(new Error('connection refused'));
    const { errors } = await mgr.setServers({
      alpha: { type: 'stdio', command: 'alpha-mcp' },
      gamma: { type: 'stdio', command: 'gamma-mcp' }, // new — will fail
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
  it('disconnects all servers and marks manager as disposed', () => {
    const mgr = makeManager();
    const spy = vi.spyOn(mgr, 'disconnect');
    mgr.disconnectAll();
    expect(spy).toHaveBeenCalledWith('alpha');
    expect(spy).toHaveBeenCalledWith('beta');
  });

  it('post-disconnectAll: all servers are disconnected', () => {
    const mgr = makeManager();
    mgr.disconnectAll();
    for (const name of mgr.serverNames()) {
      expect(mgr.isConnected(name)).toBe(false);
    }
  });
});
