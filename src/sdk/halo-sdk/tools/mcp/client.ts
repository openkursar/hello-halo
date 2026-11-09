/**
 * @module tools/mcp/client
 * MCP client — manages the lifecycle of a single MCP server connection.
 *
 * Handles the initialize handshake, tool discovery, and tool invocation
 * following the MCP protocol (version 2024-11-05).
 *
 * @license MIT
 */

import { getLogger } from '../../utils/logger.js';
import type {
  McpTransport,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
} from './jsonrpc.js';

const log = getLogger('MCP:Client');

// ---------------------------------------------------------------------------
// MCP protocol constants
// ---------------------------------------------------------------------------

const MCP_PROTOCOL_VERSION = '2024-11-05';
const CLIENT_NAME = 'agent-sdk';
const CLIENT_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// MCP types
// ---------------------------------------------------------------------------

export interface McpServerCapabilities {
  tools?: Record<string, unknown>;
  resources?: Record<string, unknown>;
  prompts?: Record<string, unknown>;
}

export interface McpServerInfo {
  name: string;
  version: string;
  description?: string;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpCallToolResult {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
    [key: string]: unknown;
  }>;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Elicitation handler type
// ---------------------------------------------------------------------------

/**
 * Callback invoked when an MCP server requests user input (elicitation).
 * The request includes `serverName` plus all MCP elicitation params.
 * Should return an ElicitResult: { action: 'accept'|'decline'|'cancel', content? }.
 */
export type McpElicitationHandler = (
  request: Record<string, unknown>,
  options: { signal: AbortSignal },
) => Promise<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// McpClient
// ---------------------------------------------------------------------------

/**
 * A client for communicating with a single MCP server.
 *
 * Usage:
 * ```ts
 * const transport = new StdioTransport({ command: 'my-mcp-server' });
 * await transport.connect();
 * const client = new McpClient(transport, 'my-server');
 * await client.initialize();
 * const tools = client.getTools();
 * const result = await client.callTool('myTool', { arg: 'value' });
 * client.close();
 * ```
 */
export class McpClient {
  private nextId = 1;
  private capabilities: McpServerCapabilities | null = null;
  private serverInfo: McpServerInfo | null = null;
  private instructions?: string;
  private tools: McpToolDefinition[] = [];
  private _initialized = false;
  private abortController = new AbortController();

  constructor(
    private readonly transport: McpTransport,
    private readonly serverName: string,
    private readonly onElicitation?: McpElicitationHandler,
  ) {}

  get initialized(): boolean {
    return this._initialized;
  }

  getServerInfo(): McpServerInfo | null {
    return this.serverInfo;
  }

  getTools(): McpToolDefinition[] {
    return this.tools;
  }

  getInstructions(): string | undefined {
    return this.instructions;
  }

  /**
   * Perform the MCP initialize handshake.
   * Must be called after the transport is connected.
   *
   * Sends `initialize` request, then `notifications/initialized`,
   * then optionally discovers tools if the server advertises tool support.
   */
  async initialize(): Promise<void> {
    // Register elicitation handler before the handshake so the server can
    // elicit user input as soon as the session is established.
    if (this.onElicitation) {
      const handler = this.onElicitation;
      const serverName = this.serverName;
      const signal = this.abortController.signal;
      this.transport.setRequestHandler('elicitation/create', async (params) => {
        // Merge serverName into the request so the handler knows which server is asking.
        const request = { serverName, ...((params as Record<string, unknown>) ?? {}) };
        return handler(request, { signal });
      });
    }

    const capabilities: Record<string, unknown> = {
      roots: { listChanged: false },
    };
    if (this.onElicitation) {
      // Declare elicitation capability so the server knows we support it
      capabilities['elicitation'] = {};
    }

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities,
        clientInfo: {
          name: CLIENT_NAME,
          version: CLIENT_VERSION,
        },
      },
    };

    const response = await this.transport.send(request);

    if (response.error) {
      throw new Error(
        `MCP initialize failed for "${this.serverName}": ${response.error.message}`,
      );
    }

    const result = response.result as {
      protocolVersion?: string;
      capabilities?: McpServerCapabilities;
      serverInfo?: McpServerInfo;
      instructions?: unknown;
    } | undefined;

    this.capabilities = result?.capabilities ?? {};
    this.serverInfo = {
      name: typeof result?.serverInfo?.name === 'string' ? result.serverInfo.name : this.serverName,
      version: typeof result?.serverInfo?.version === 'string' ? result.serverInfo.version : 'unknown',
      ...(typeof result?.serverInfo?.description === 'string' ? { description: result.serverInfo.description } : {}),
    };
    this.instructions = typeof result?.instructions === 'string' ? result.instructions : undefined;

    // Send initialized notification (no response expected)
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    };
    await this.transport.notify(notification);

    this._initialized = true;

    // Discover tools if server supports them
    if (this.capabilities?.tools) {
      await this.discoverTools();
    }
  }

  /**
   * Discover available tools via `tools/list`.
   */
  private async discoverTools(): Promise<void> {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/list',
    };

    const response = await this.transport.send(request);

    if (response.error) {
      // Non-fatal: warn and continue without tools
      log.warn('tools/list failed', { server: this.serverName, err: response.error.message });
      return;
    }

    const result = response.result as {
      tools?: McpToolDefinition[];
    } | undefined;

    this.tools = result?.tools ?? [];
  }

  /**
   * Call a tool on the MCP server.
   *
   * @param toolName - The tool name (without server prefix)
   * @param args - Tool arguments
   * @returns The tool result with content blocks
   */
  async callTool(
    toolName: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallToolResult> {
    if (!this._initialized) {
      return {
        content: [{ type: 'text', text: `MCP server "${this.serverName}" not initialized` }],
        isError: true,
      };
    }

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    };

    signal?.throwIfAborted();
    const response = await new Promise<JsonRpcResponse>((resolve, reject) => {
      let submitted = false;
      const abort = () => {
        if (submitted) void this.transport.notify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: request.id, reason: 'Caller cancelled the tool request' } })
          .catch(error => log.warn('Tool cancellation could not be delivered', { server: this.serverName, error: String(error) }));
        reject(new Error('MCP tool request cancelled'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      void Promise.resolve().then(() => {
        signal?.throwIfAborted();
        submitted = true;
        return this.transport.send(request, signal);
      }).then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
    });

    if (response.error) {
      return {
        content: [{
          type: 'text',
          text: `MCP tool error (${this.serverName}/${toolName}): ${response.error.message}`,
        }],
        isError: true,
      };
    }

    return (response.result as McpCallToolResult) ?? {
      content: [{ type: 'text', text: '' }],
      isError: false,
    };
  }

  /**
   * Close the client and its underlying transport.
   */
  close(): void {
    this.abortController.abort();
    this.transport.close();
    this._initialized = false;
    this.tools = [];
    this.serverInfo = null;
    this.instructions = undefined;
  }

  whenClosed(): Promise<void> { return this.transport.whenClosed?.() ?? Promise.resolve(); }
}
