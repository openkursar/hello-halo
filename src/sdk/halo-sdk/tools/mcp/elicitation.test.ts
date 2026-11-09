/**
 * Unit tests for MCP elicitation support.
 *
 * Tests verify the full elicitation pipeline:
 *   Transport.setRequestHandler → McpClient wiring → McpConnectionManager propagation
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  McpTransport,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  ServerRequestHandler,
} from './jsonrpc.js';
import { McpClient } from './client.js';
import { McpConnectionManager, createMcpConnectionManager } from './connection-manager.js';

// ---------------------------------------------------------------------------
// Mock transport
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory transport for unit testing.
 * Captures registered request handlers and allows simulating server requests.
 */
class MockTransport implements McpTransport {
  readonly connected = true;
  private handlers = new Map<string, ServerRequestHandler>();
  /** Responses written back via simulated I/O. */
  readonly responses: unknown[] = [];

  setRequestHandler(method: string, handler: ServerRequestHandler): void {
    this.handlers.set(method, handler);
  }

  hasHandler(method: string): boolean {
    return this.handlers.has(method);
  }

  /** Simulate a server-initiated request arriving on this transport. */
  async simulateServerRequest(method: string, params: unknown): Promise<unknown> {
    const handler = this.handlers.get(method);
    if (!handler) throw new Error(`No handler registered for method: ${method}`);
    return handler(params);
  }

  async send(_request: JsonRpcRequest): Promise<JsonRpcResponse> {
    return { jsonrpc: '2.0', id: _request.id, result: { capabilities: { tools: {} } } };
  }

  async notify(_notification: JsonRpcNotification): Promise<void> { /* no-op */ }

  close(): void { /* no-op */ }
}

// ---------------------------------------------------------------------------
// Transport.setRequestHandler
// ---------------------------------------------------------------------------

describe('Transport.setRequestHandler', () => {
  it('stores the handler and returns result from handler', async () => {
    const transport = new MockTransport();
    const handler = vi.fn().mockResolvedValue({ action: 'accept', content: { name: 'Alice' } });

    transport.setRequestHandler('elicitation/create', handler);
    expect(transport.hasHandler('elicitation/create')).toBe(true);

    const result = await transport.simulateServerRequest('elicitation/create', {
      message: 'What is your name?',
      mode: 'form',
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(result).toEqual({ action: 'accept', content: { name: 'Alice' } });
  });

  it('multiple handlers for different methods coexist', async () => {
    const transport = new MockTransport();
    const h1 = vi.fn().mockResolvedValue({ action: 'accept' });
    const h2 = vi.fn().mockResolvedValue({ action: 'decline' });

    transport.setRequestHandler('elicitation/create', h1);
    transport.setRequestHandler('custom/method', h2);

    await transport.simulateServerRequest('elicitation/create', {});
    await transport.simulateServerRequest('custom/method', {});

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// McpClient elicitation wiring
// ---------------------------------------------------------------------------

describe('McpClient elicitation wiring', () => {
  it('registers elicitation/create handler on transport when onElicitation is provided', async () => {
    const transport = new MockTransport();
    const onElicitation = vi.fn().mockResolvedValue({ action: 'accept', content: {} });
    const client = new McpClient(transport, 'test-server', onElicitation);

    await client.initialize();

    expect(transport.hasHandler('elicitation/create')).toBe(true);
  });

  it('does NOT register handler when onElicitation is not provided', async () => {
    const transport = new MockTransport();
    const client = new McpClient(transport, 'test-server');

    await client.initialize();

    expect(transport.hasHandler('elicitation/create')).toBe(false);
  });

  it('calls onElicitation with serverName injected into request', async () => {
    const transport = new MockTransport();
    const onElicitation = vi.fn().mockResolvedValue({ action: 'accept', content: {} });
    const client = new McpClient(transport, 'my-server', onElicitation);

    await client.initialize();

    // Simulate server sending an elicitation/create request
    const mcpParams = { message: 'Enter your token:', mode: 'form' };
    await transport.simulateServerRequest('elicitation/create', mcpParams);

    expect(onElicitation).toHaveBeenCalledOnce();
    const [request, options] = onElicitation.mock.calls[0];
    // serverName must be merged into the request object
    expect(request.serverName).toBe('my-server');
    expect(request.message).toBe('Enter your token:');
    expect(request.mode).toBe('form');
    // signal must be provided
    expect(options).toHaveProperty('signal');
  });

  it('declares elicitation capability in initialize when handler provided', async () => {
    const transport = new MockTransport();
    const sendSpy = vi.spyOn(transport, 'send');
    const onElicitation = vi.fn().mockResolvedValue({ action: 'accept' });

    const client = new McpClient(transport, 'cap-server', onElicitation);
    await client.initialize();

    const initCall = sendSpy.mock.calls.find(([req]) => req.method === 'initialize');
    expect(initCall).toBeDefined();
    const params = initCall![0].params as Record<string, unknown>;
    const capabilities = params.capabilities as Record<string, unknown>;
    expect(capabilities).toHaveProperty('elicitation');
  });

  it('does NOT declare elicitation capability without handler', async () => {
    const transport = new MockTransport();
    const sendSpy = vi.spyOn(transport, 'send');

    const client = new McpClient(transport, 'no-cap-server');
    await client.initialize();

    const initCall = sendSpy.mock.calls.find(([req]) => req.method === 'initialize');
    expect(initCall).toBeDefined();
    const params = initCall![0].params as Record<string, unknown>;
    const capabilities = params.capabilities as Record<string, unknown>;
    expect(capabilities).not.toHaveProperty('elicitation');
  });
});

// ---------------------------------------------------------------------------
// McpConnectionManager elicitation propagation
// ---------------------------------------------------------------------------

describe('McpConnectionManager.setElicitationHandler', () => {
  it('accepts a handler via setElicitationHandler', () => {
    const mgr = new McpConnectionManager();
    const handler = vi.fn().mockResolvedValue({ action: 'decline' });
    // Should not throw
    expect(() => mgr.setElicitationHandler(handler)).not.toThrow();
  });
});

describe('createMcpConnectionManager', () => {
  it('accepts onElicitation option', () => {
    const handler = vi.fn().mockResolvedValue({ action: 'accept' });
    const mgr = createMcpConnectionManager(
      undefined,
      { onElicitation: handler },
    );
    // Manager created successfully with elicitation configured
    expect(mgr).toBeInstanceOf(McpConnectionManager);
  });

  it('creates manager without elicitation option (backward compat)', () => {
    const mgr = createMcpConnectionManager(undefined);
    expect(mgr).toBeInstanceOf(McpConnectionManager);
  });

  it('skips SDK-type servers regardless of elicitation option', () => {
    const handler = vi.fn().mockResolvedValue({ action: 'accept' });
    const mgr = createMcpConnectionManager(
      { 'local-sdk': { type: 'sdk' } },
      { onElicitation: handler },
    );
    // SDK-type server should not be registered for external connection
    expect(mgr.serverNames()).not.toContain('local-sdk');
  });
});
