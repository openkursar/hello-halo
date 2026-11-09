/**
 * @module tools/mcp/jsonrpc
 * JSON-RPC 2.0 protocol types and transport interface for MCP communication.
 * @license MIT
 */

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 types
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Transport interface
// ---------------------------------------------------------------------------

/** Handler for server-initiated JSON-RPC requests. Returns the result payload. */
export type ServerRequestHandler = (params: unknown) => Promise<unknown>;

/**
 * Transport abstraction for MCP communication.
 * Handles the low-level I/O for sending/receiving JSON-RPC messages.
 */
export interface McpTransport {
  /** Connect the transport (spawn process, open HTTP connection, etc.). */
  connect(): Promise<void>;
  /** Send a JSON-RPC request and wait for the matching response. */
  send(request: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse>;
  /** Send a JSON-RPC notification (no response expected). */
  notify(notification: JsonRpcNotification): Promise<void>;
  /** Close the transport and release resources. */
  close(): void;
  /** Optional asynchronous transport retirement, including HTTP session deletion. */
  whenClosed?(): Promise<void>;
  /** Whether the transport is currently connected. */
  readonly connected: boolean;
  /**
   * Register a handler for server-initiated requests of a given method.
   * When the server sends a request with this method, the handler is called
   * and its return value is sent back as the JSON-RPC response.
   */
  setRequestHandler(method: string, handler: ServerRequestHandler): void;
}
