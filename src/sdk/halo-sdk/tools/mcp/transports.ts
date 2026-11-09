/**
 * @module tools/mcp/transports
 * MCP transport implementations: stdio, SSE, and streamable-http.
 *
 * Each transport manages the low-level I/O for JSON-RPC 2.0 communication
 * with an external MCP server. The transports follow the MCP specification
 * (protocol version 2024-11-05).
 *
 * @license MIT
 */

import type { ChildProcess } from 'node:child_process';
import { spawn, killProcessTree } from '../../utils/processes.js';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { RequestScope } from './request-scope.js';
import { getLogger } from '../../utils/logger.js';
import type {
  McpTransport,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  ServerRequestHandler,
} from './jsonrpc.js';

/** Default timeout for individual JSON-RPC requests (30 seconds). */
const REQUEST_TIMEOUT_MS = 30_000;

/** Timeout for initial connection/handshake (15 seconds). */
const CONNECT_TIMEOUT_MS = 15_000;

/** Grace period before SIGKILL after SIGTERM (5 seconds). */
const FORCE_KILL_MS = 5_000;

// ---------------------------------------------------------------------------
// Pending request tracking (shared across transports)
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (res: JsonRpcResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function rejectAllPending(
  pending: Map<number, PendingRequest>,
  reason: string,
): void {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
    pending.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Stdio Transport
// ---------------------------------------------------------------------------

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * Stdio MCP transport — communicates with an MCP server via a child process.
 * JSON-RPC messages are sent as newline-delimited JSON on stdin, and
 * responses are read line-by-line from stdout.
 */
export class StdioTransport implements McpTransport {
  private process: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private pending = new Map<number, PendingRequest>();
  private requestHandlers = new Map<string, ServerRequestHandler>();
  private _connected = false;
  private cancelConnect?: () => void;
  private connecting?: Promise<void>;

  constructor(private readonly options: StdioTransportOptions) {}

  setRequestHandler(method: string, handler: ServerRequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  get connected(): boolean {
    return this._connected;
  }

  connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this._connected) return Promise.resolve();
    const opening = this.open();
    this.connecting = opening;
    void opening.finally(() => { if (this.connecting === opening) this.connecting = undefined; }).catch(() => {});
    return opening;
  }

  private async open(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const env = { ...process.env, ...this.options.env };

      const child = spawn(this.options.command, this.options.args ?? [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        cwd: this.options.cwd,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      this.process = child;

      const timeout = setTimeout(() => {
        cleanup();
        child.once('error', () => {}); // A cancelled OS spawn may still report its error.
        if (child.pid) killProcessTree(child.pid, 'SIGKILL');
        reject(new Error(
          `MCP server "${this.options.command}" did not start within ${CONNECT_TIMEOUT_MS}ms`,
        ));
      }, CONNECT_TIMEOUT_MS);

      const onError = (err: Error) => {
        cleanup();
        if (this.process === child) this.process = null;
        reject(new Error(
          `Failed to spawn MCP server "${this.options.command}": ${err.message}`,
        ));
      };

      const onSpawn = () => {
        cleanup();
        if (this.process !== child) {
          if (child.pid) killProcessTree(child.pid, 'SIGKILL');
          reject(new Error('MCP transport closed during connection'));
          return;
        }
        this.setupIO();
        this._connected = true;
        resolve();
      };

      const cleanup = () => {
        clearTimeout(timeout);
        child.removeListener('error', onError);
        child.removeListener('spawn', onSpawn);
        if (this.cancelConnect === cancel) this.cancelConnect = undefined;
      };
      const cancel = () => {
        cleanup();
        child.once('error', () => {}); // The caller already received the cancellation.
        if (!child.pid) child.once('spawn', () => { if (child.pid) killProcessTree(child.pid, 'SIGKILL'); });
        reject(new Error('MCP transport closed during connection'));
      };
      this.cancelConnect = cancel;

      child.once('error', onError);
      child.once('spawn', onSpawn);
    });
  }

  private setupIO(): void {
    if (!this.process?.stdout) return;

    this.readline = createInterface({ input: this.process.stdout });
    this.readline.on('line', (line) => this.handleLine(line));

    this.process.on('exit', (_code, _signal) => {
      this._connected = false;
      rejectAllPending(this.pending, 'MCP server process exited');
    });

    this.process.on('error', (err) => {
      this._connected = false;
      rejectAllPending(this.pending, `MCP server process error: ${err.message}`);
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const msg = JSON.parse(trimmed) as Record<string, unknown>;

      // Server-initiated request: has 'method' field (and optionally 'id')
      if (typeof msg.method === 'string') {
        if (msg.id !== undefined) {
          const handler = this.requestHandlers.get(msg.method);
          if (handler) {
            void handler(msg.params).then(
              (result) => this.writeRpcResponse(msg.id, result),
              (err: unknown) => this.writeRpcResponse(msg.id, undefined, {
                code: -32000,
                message: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        }
        // Notifications (no id) are silently ignored
        return;
      }

      // Response to our request: has 'id' + 'result'/'error'
      if (
        typeof msg.id === 'number' &&
        (msg.result !== undefined || msg.error !== undefined)
      ) {
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          clearTimeout(entry.timer);
          entry.resolve(msg as unknown as JsonRpcResponse);
        }
      }
    } catch {
      // Non-JSON output (e.g. stderr leaking to stdout) — ignore
    }
  }

  private writeRpcResponse(id: unknown, result?: unknown, error?: { code: number; message: string }): void {
    if (!this.process?.stdin || !this._connected) return;
    const response = error !== undefined
      ? { jsonrpc: '2.0', id, error }
      : { jsonrpc: '2.0', id, result: result ?? null };
    this.process.stdin.write(JSON.stringify(response) + '\n');
  }

  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (!this.process?.stdin || !this._connected) {
      throw new Error('Stdio transport not connected');
    }

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new Error(
          `MCP request timeout: ${request.method} (id=${request.id})`,
        ));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(request.id, { resolve, reject, timer });

      const json = JSON.stringify(request) + '\n';
      this.process!.stdin!.write(json, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(request.id);
          reject(new Error(`Failed to write to MCP server stdin: ${err.message}`));
        }
      });
    });
  }

  async notify(notification: JsonRpcNotification): Promise<void> {
    if (!this.process?.stdin || !this._connected) {
      throw new Error('Stdio transport not connected');
    }

    return new Promise<void>((resolve, reject) => {
      const json = JSON.stringify(notification) + '\n';
      this.process!.stdin!.write(json, (err) => {
        if (err) reject(new Error(`Failed to write notification: ${err.message}`));
        else resolve();
      });
    });
  }

  close(): void {
    this._connected = false;
    this.connecting = undefined;
    this.cancelConnect?.();

    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    if (this.process) {
      const child = this.process;
      this.process = null;

      child.stdin?.end();
      if (child.exitCode === null && child.signalCode === null && child.pid) killProcessTree(child.pid, 'SIGTERM');

      // Force kill after grace period
      const forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null && child.pid) killProcessTree(child.pid, 'SIGKILL');
      }, FORCE_KILL_MS);
      child.once('exit', () => clearTimeout(forceKillTimer));
    }

    rejectAllPending(this.pending, 'Transport closed');
  }
}

// ---------------------------------------------------------------------------
// SSE Transport
// ---------------------------------------------------------------------------

export interface SSETransportOptions {
  url: string;
  headers?: Record<string, string>;
}

/**
 * SSE MCP transport — connects to an MCP server via Server-Sent Events.
 *
 * Protocol flow:
 * 1. Client opens GET connection to the SSE URL
 * 2. Server sends an "endpoint" event with the POST URL
 * 3. Client POSTs JSON-RPC messages to the endpoint
 * 4. Server sends responses back via SSE "message" events
 */
export class SSETransport implements McpTransport {
  private _connected = false;
  private requests = new RequestScope();
  private connecting?: Promise<void>;
  private endpointUrl: string | null = null;
  private abortController: AbortController | null = null;
  private pending = new Map<number, PendingRequest>();
  private requestHandlers = new Map<string, ServerRequestHandler>();

  constructor(private readonly options: SSETransportOptions) {}

  setRequestHandler(method: string, handler: ServerRequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  get connected(): boolean {
    return this._connected;
  }

  connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this._connected && this.endpointUrl) return Promise.resolve();
    const opening = this.open();
    this.connecting = opening;
    void opening.finally(() => { if (this.connecting === opening) this.connecting = undefined; }).catch(() => {});
    return opening;
  }

  private async open(): Promise<void> {
    const controller = new AbortController();
    const requests = new RequestScope();
    this.abortController = controller;
    this.requests = requests;
    const timeout = setTimeout(() => controller.abort(new Error('SSE connection timed out')), CONNECT_TIMEOUT_MS);
    try {
      const response = await fetch(this.options.url, {
        headers: { Accept: 'text/event-stream', ...this.options.headers }, signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
      }
      if (!response.body) throw new Error('SSE response has no body');
      controller.signal.throwIfAborted();
      this._connected = true;
      void this.readSSEStream(response.body, controller, requests);
      while (!this.endpointUrl) {
        await delay(50, undefined, { signal: controller.signal });
      }
    } catch (error) {
      if (this.abortController === controller) this.close();
      throw error;
    } finally { clearTimeout(timeout); }
  }

  private async readSSEStream(body: ReadableStream<Uint8Array>, controller: AbortController, requests: RequestScope): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventType = '';
    let eventData = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            eventData += line.slice(6);
          } else if (line === '') {
            // End of SSE event — dispatch
            if (!controller.signal.aborted) this.handleSSEEvent(eventType, eventData, requests);
            eventType = '';
            eventData = '';
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) getLogger('MCP:Transport').warn('SSE connection failed', { error: String(error) });
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      if (this.abortController === controller) this.close();
    }
  }

  private handleSSEEvent(eventType: string, data: string, requests: RequestScope): void {
    if (eventType === 'endpoint') {
      // Resolve the endpoint URL (may be relative to the SSE URL)
      try {
        this.endpointUrl = new URL(data.trim(), this.options.url).href;
      } catch {
        this.endpointUrl = data.trim();
      }
      return;
    }

    if (eventType === 'message' && data) {
      try {
        const msg = JSON.parse(data) as Record<string, unknown>;

        // Server-initiated request: has 'method' field
        if (typeof msg.method === 'string') {
          if (msg.id !== undefined) {
            const handler = this.requestHandlers.get(msg.method);
            if (handler) {
              void handler(msg.params).then(
                (result) => this.postRpcResponse(msg.id, result, undefined, requests),
                (err: unknown) => this.postRpcResponse(msg.id, undefined, {
                  code: -32000,
                  message: err instanceof Error ? err.message : String(err),
                }, requests),
              );
            }
          }
          return;
        }

        // Response to our request
        if (
          typeof msg.id === 'number' &&
          (msg.result !== undefined || msg.error !== undefined)
        ) {
          const entry = this.pending.get(msg.id);
          if (entry) {
            this.pending.delete(msg.id);
            clearTimeout(entry.timer);
            entry.resolve(msg as unknown as JsonRpcResponse);
          }
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  private postRpcResponse(id: unknown, result?: unknown, error?: { code: number; message: string }, requests = this.requests): void {
    if (!this.endpointUrl || !this._connected || requests.signal.aborted || requests !== this.requests) return;
    const response = error !== undefined
      ? { jsonrpc: '2.0', id, error }
      : { jsonrpc: '2.0', id, result: result ?? null };
    const endpoint = this.endpointUrl;
    void requests.run(async signal => {
      const reply = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.options.headers },
        body: JSON.stringify(response), signal,
      });
      await reply.body?.cancel();
      if (!reply.ok) throw new Error(`MCP response POST failed: ${reply.status}`);
    }).catch(error => {
      if (!requests.signal.aborted) getLogger('MCP:Transport').warn('SSE server request response failed', { error: String(error) });
    });
  }

  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (!this.endpointUrl || !this._connected) {
      throw new Error('SSE transport not connected');
    }

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new Error(
          `MCP request timeout: ${request.method} (id=${request.id})`,
        ));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(request.id, { resolve, reject, timer });

      // POST the request to the endpoint; response arrives via SSE stream
      void this.requests.run(async signal => {
        const response = await fetch(this.endpointUrl!, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...this.options.headers,
          },
          body: JSON.stringify(request), signal,
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error(`SSE POST failed: ${response.status}`);
      }).catch((err: Error) => {
        clearTimeout(timer);
        this.pending.delete(request.id);
        reject(new Error(`SSE POST failed: ${err.message}`));
      });
    });
  }

  async notify(notification: JsonRpcNotification): Promise<void> {
    if (!this.endpointUrl || !this._connected) {
      throw new Error('SSE transport not connected');
    }

    await this.requests.run(async signal => {
      const response = await fetch(this.endpointUrl!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.options.headers,
        },
        body: JSON.stringify(notification), signal,
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`SSE notification failed: ${response.status}`);
    });
  }

  close(): void {
    this._connected = false;
    this.connecting = undefined;
    this.requests.close();
    this.endpointUrl = null;

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    rejectAllPending(this.pending, 'Transport closed');
  }
}

// ---------------------------------------------------------------------------
// HTTP (Streamable HTTP) Transport
// ---------------------------------------------------------------------------

export interface HttpTransportOptions {
  url: string;
  headers?: Record<string, string>;
}

/**
 * Streamable HTTP MCP transport — communicates via HTTP POST requests.
 *
 * Each request is POSTed to the URL. The response is either:
 * - Plain JSON (Content-Type: application/json) — direct response
 * - SSE stream (Content-Type: text/event-stream) — parse for response
 */
export class HttpTransport implements McpTransport {
  private _connected = false;
  private requestHandlers = new Map<string, ServerRequestHandler>();
  private requests = new RequestScope();
  private sessionId: string | undefined;
  private protocolVersion: string | undefined;
  private retirement: Promise<void> = Promise.resolve();
  private revision = 0;

  constructor(private readonly options: HttpTransportOptions) {}

  setRequestHandler(method: string, handler: ServerRequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    if (this._connected) return;
    const revision = this.revision;
    await this.retirement;
    if (revision !== this.revision) throw new Error('MCP HTTP connection was cancelled');
    if (this._connected) return;
    if (this.requests.signal.aborted) this.requests = new RequestScope();
    this.sessionId = undefined;
    this.protocolVersion = undefined;
    this._connected = true;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...this.options.headers,
      ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
      ...(this.protocolVersion ? { 'MCP-Protocol-Version': this.protocolVersion } : {}),
    };
  }

  async send(request: JsonRpcRequest, callerSignal?: AbortSignal): Promise<JsonRpcResponse> {
    if (!this._connected) {
      throw new Error('HTTP transport not connected');
    }

    const requests = this.requests;
    return requests.run(async signal => {
      const response = await fetch(this.options.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(request),
        signal,
      });

      if (!response.ok) {
        if (response.status === 404 && this.sessionId) this._connected = false;
        await response.body?.cancel();
        throw new Error(
          `HTTP MCP request failed: ${response.status} ${response.statusText}`,
        );
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (requests.signal.aborted || requests !== this.requests || !this._connected) {
        await response.body?.cancel();
        throw new Error('MCP connection closed before response admission');
      }
      if (request.method === 'initialize') this.sessionId = response.headers.get('mcp-session-id') ?? undefined;

      // Streamable HTTP may respond with an SSE stream
      if (contentType.includes('text/event-stream') && response.body) {
        const result = await this.parseSSEResponse(response.body, request.id, requests);
        if (requests.signal.aborted || requests !== this.requests) throw new Error('MCP connection closed while reading response');
        if (request.method === 'initialize') this.protocolVersion = (result.result as { protocolVersion?: string } | undefined)?.protocolVersion;
        return result;
      }

      // Plain JSON response
      const json = await response.json() as JsonRpcResponse;
      if (requests.signal.aborted || requests !== this.requests) throw new Error('MCP connection closed while reading response');
      if (request.method === 'initialize') this.protocolVersion = (json.result as { protocolVersion?: string } | undefined)?.protocolVersion;
      return json as JsonRpcResponse;
    }, REQUEST_TIMEOUT_MS, callerSignal);
  }

  private async parseSSEResponse(
    body: ReadableStream<Uint8Array>,
    requestId: number,
    requests: RequestScope,
  ): Promise<JsonRpcResponse> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventData = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            eventData += line.slice(6);
          } else if (line === '' && eventData) {
            try {
              const msg = JSON.parse(eventData) as Record<string, unknown>;

              // Server-initiated request embedded in the SSE stream
              if (typeof msg.method === 'string' && msg.id !== undefined) {
                const handler = this.requestHandlers.get(msg.method);
                if (handler) {
                  void handler(msg.params).then(
                    (result) => this.postRpcResponse(msg.id, result, undefined, requests),
                    (err: unknown) => this.postRpcResponse(msg.id, undefined, {
                      code: -32000,
                      message: err instanceof Error ? err.message : String(err),
                    }, requests),
                  );
                }
              } else if (msg.id === requestId) {
                return msg as unknown as JsonRpcResponse;
              }
            } catch {
              // Ignore parse errors
            }
            eventData = '';
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }

    throw new Error(`No response received for request id=${requestId}`);
  }

  private postRpcResponse(id: unknown, result?: unknown, error?: { code: number; message: string }, requests = this.requests): void {
    if (!this._connected || requests.signal.aborted || requests !== this.requests) return;
    const response = error !== undefined
      ? { jsonrpc: '2.0', id, error }
      : { jsonrpc: '2.0', id, result: result ?? null };
    void requests.run(async signal => {
      const reply = await fetch(this.options.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(response),
        signal,
      });
      await reply.body?.cancel();
      if (!reply.ok) throw new Error(`MCP response POST failed: ${reply.status}`);
    }).catch(error => {
      if (!requests.signal.aborted) getLogger('MCP:Transport').warn('Server request response failed', { error: String(error) });
    });
  }

  async notify(notification: JsonRpcNotification): Promise<void> {
    if (!this._connected) {
      throw new Error('HTTP transport not connected');
    }

    await this.requests.run(async signal => {
      const response = await fetch(this.options.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(notification),
        signal,
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`MCP notification failed: ${response.status}`);
    });
  }

  close(): void {
    const headers = this.headers();
    const hadSession = this.sessionId !== undefined;
    this.revision++;
    this._connected = false;
    this.requests.close();
    this.sessionId = undefined;
    this.protocolVersion = undefined;
    if (hadSession) this.retirement = this.retirement.then(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      timer.unref?.();
      try {
        const response = await fetch(this.options.url, { method: 'DELETE', headers, signal: controller.signal });
        await response.body?.cancel();
        if (!response.ok && response.status !== 404 && response.status !== 405) {
          getLogger('MCP:Transport').warn('HTTP session retirement refused', { status: response.status });
        }
      } catch (error) {
        getLogger('MCP:Transport').warn('HTTP session retirement could not be confirmed', { error: String(error) });
      } finally { clearTimeout(timer); }
    });
  }

  whenClosed(): Promise<void> { return this.retirement; }
}
