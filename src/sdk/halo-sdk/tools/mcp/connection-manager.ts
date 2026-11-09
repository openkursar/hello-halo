/**
 * @module tools/mcp/connection-manager
 * MCP Connection Manager — manages lifecycle (connect / disconnect / reconnect)
 * for a set of external MCP servers.
 *
 * Features:
 *   - Per-server status tracking (Connected, Connecting, Disconnected, Failed)
 *   - Exponential-backoff reconnection loops (1s → 2s → 4s → … capped at 60s)
 *   - Connect / disconnect / restart control plane
 *   - Tool-call-level reconnection: if a tool call fails because the transport
 *     disconnected, the manager attempts a single reconnect before returning error
 *
 * @license MIT
 */

import { getLogger } from '../../utils/logger.js';
import { createHash } from 'node:crypto';
import type { Tool, ToolResult, ToolContext } from '../../types/tool.js';
import { McpClient, type McpToolDefinition, type McpElicitationHandler } from './client.js';
import { StdioTransport, SSETransport, HttpTransport } from './transports.js';
import type { McpTransport } from './jsonrpc.js';
import { assertUniqueMcpToolNames, formatCallToolResult, normalizeNameForMCP, truncateDescription } from './bridge.js';
import type { McpServerConnectionStatus } from './bridge.js';

const log = getLogger('MCP:ConnectionManager');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const BACKOFF_MULTIPLIER = 2;

// ---------------------------------------------------------------------------
// Status types
// ---------------------------------------------------------------------------

/** Live connection status for a single MCP server. */
export type McpServerLiveStatus =
  | { state: 'connected'; toolCount: number }
  | { state: 'connecting' }
  | { state: 'disconnected'; lastError?: string }
  | { state: 'failed'; error: string; retryAt: number };

// ---------------------------------------------------------------------------
// Internal per-server state
// ---------------------------------------------------------------------------

interface ServerEntry {
  name: string;
  config: Record<string, unknown>;
  status: McpServerLiveStatus;
  client: McpClient | null;
  transport: McpTransport | null;
  tools: McpToolDefinition[];
  definitionFingerprints: Map<string, string>;
  configRevision: number;
  published: boolean;
  description?: string;
  instructions?: string;
  /** Handle returned by setTimeout for the reconnect loop. */
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** Current backoff duration in ms. */
  backoffMs: number;
  /** Whether the reconnect loop is running. */
  reconnecting: boolean;
  revision: number;
  attempt?: ConnectionAttempt;
}

interface ConnectionAttempt {
  client: McpClient;
  closed: boolean;
  promise: Promise<void>;
  cancel(): void;
}

// ---------------------------------------------------------------------------
// McpConnectionManager
// ---------------------------------------------------------------------------

/**
 * Manages lifecycle for a set of external MCP servers.
 *
 * Usage:
 * ```ts
 * const mgr = new McpConnectionManager();
 * mgr.addServer('my-db', { type: 'stdio', command: 'my-mcp-server' });
 * await mgr.connectAll();
 *
 * const tools = mgr.getBridgedTools(); // Tool[] for the query loop
 * const statuses = mgr.getStatuses();  // for init message
 *
 * // On session close:
 * mgr.disconnectAll();
 * ```
 */
export class McpConnectionManager {
  private servers = new Map<string, ServerEntry>();
  private _disposed = false;
  private elicitationHandler?: McpElicitationHandler;
  private preparations = new Set<Promise<void>>();
  private toolCatalogRevision = 0;
  private issuedTools = new WeakSet<Tool>();

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /**
   * Set the elicitation handler for all server connections.
   * Must be called before connectAll() / connect() to take effect.
   */
  setElicitationHandler(handler: McpElicitationHandler): void {
    this.elicitationHandler = handler;
  }

  // -------------------------------------------------------------------------
  // Server registration
  // -------------------------------------------------------------------------

  /**
   * Register a server config. Does not connect yet.
   */
  addServer(name: string, config: Record<string, unknown>): void {
    if (this._disposed) throw new Error('MCP connection manager is disposed');
    if (this.servers.has(name)) return; // idempotent
    this.servers.set(name, {
      name,
      config,
      status: { state: 'disconnected' },
      client: null,
      transport: null,
      tools: [],
      definitionFingerprints: new Map(),
      configRevision: 0,
      published: false,
      reconnectTimer: null,
      backoffMs: INITIAL_BACKOFF_MS,
      reconnecting: false,
      revision: 0,
    });
  }

  // -------------------------------------------------------------------------
  // Connect / disconnect / restart
  // -------------------------------------------------------------------------

  /**
   * Connect all registered servers. Errors are non-fatal per server.
   */
  async connectAll(): Promise<void> {
    if (this._disposed) throw new Error('MCP connection manager is disposed');
    const promises = Array.from(this.servers.keys()).map((name) =>
      this.connect(name).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (!this._disposed) log.warn('server failed to connect', { server: name, err: msg });
      }),
    );
    await Promise.all(promises);
  }

  /**
   * Connect to a single server by name.
   */
  async connect(name: string): Promise<void> {
    if (this._disposed) throw new Error('MCP connection manager is disposed');
    const entry = this.servers.get(name);
    if (!entry) throw new Error(`Unknown MCP server: ${name}`);
    if (entry.attempt) return entry.attempt.promise;
    if (entry.client && entry.transport?.connected) return;
    entry.revision++;
    this.closeClient(entry);
    entry.status = { state: 'connecting' };
    const transport = createTransport(entry.name, entry.config);
    if (!transport) {
      entry.status = { state: 'disconnected', lastError: 'unsupported transport type' };
      return;
    }
    const client = new McpClient(transport, entry.name, this.elicitationHandler);
    let cancel!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new Error(`MCP connection "${name}" was cancelled`));
    });
    const attempt: ConnectionAttempt = { client, closed: false, promise: null!, cancel };
    entry.attempt = attempt;
    const owns = () => !this._disposed && this.servers.get(name) === entry && entry.attempt === attempt;
    const prepare = (async () => {
      await transport.connect();
      if (!owns()) throw new Error(`MCP connection "${name}" was superseded`);
      await client.initialize();
      if (!owns()) throw new Error(`MCP connection "${name}" was superseded`);
      const tools = client.getTools();
      const names = new Set<string>();
      for (const tool of tools) {
        const normalized = normalizeNameForMCP(tool.name);
        if (names.has(normalized)) {
          throw new Error(`MCP tool identity collision: mcp__${normalizeNameForMCP(name)}__${normalized}`);
        }
        names.add(normalized);
      }
      const fingerprints = new Map(tools.map(tool => [tool.name, fingerprintDefinition(tool, client)]));
      if ((!entry.published && fingerprints.size > 0) || fingerprints.size !== entry.definitionFingerprints.size ||
          [...fingerprints].some(([name, fingerprint]) => entry.definitionFingerprints.get(name) !== fingerprint)) {
        this.toolCatalogRevision++;
      }
      entry.definitionFingerprints = fingerprints;
      entry.published = true;
      entry.description = client.getServerInfo()?.description;
      entry.instructions = client.getInstructions();
      entry.transport = transport;
      entry.client = client;
      entry.tools = tools;
      entry.status = { state: 'connected', toolCount: entry.tools.length };
      entry.backoffMs = INITIAL_BACKOFF_MS;
      entry.reconnecting = false;
    })();
    this.preparations.add(prepare);
    void prepare.finally(() => this.preparations.delete(prepare)).catch(() => {});
    attempt.promise = Promise.race([prepare, cancelled]).catch(error => {
      this.closeAttempt(entry, attempt);
      if (owns()) {
        if (entry.published && entry.definitionFingerprints.size) this.toolCatalogRevision++;
        entry.published = false;
        entry.tools = [];
        entry.status = { state: 'disconnected', lastError: error instanceof Error ? error.message : String(error) };
      }
      throw error;
    }).finally(() => { if (entry.attempt === attempt) entry.attempt = undefined; });
    return attempt.promise;
  }

  private closeAttempt(entry: ServerEntry, attempt: ConnectionAttempt): void {
    if (attempt.closed) return;
    attempt.closed = true;
    try { attempt.client.close(); this.trackRetirement(attempt.client); }
    catch (error) { log.warn('MCP preparation cleanup failed', { server: entry.name, error: String(error) }); }
  }

  private closeClient(entry: ServerEntry): void {
    const client = entry.client;
    entry.client = null;
    entry.transport = null;
    if (client) {
      try { client.close(); this.trackRetirement(client); }
      catch (error) { log.warn('MCP connection cleanup failed', { server: entry.name, error: String(error) }); }
    }
  }

  private trackRetirement(client: McpClient): void {
    const retiring = client.whenClosed();
    this.preparations.add(retiring);
    void retiring.finally(() => this.preparations.delete(retiring)).catch(error => log.warn('MCP transport retirement failed', { error: String(error) }));
  }

  /**
   * Disconnect a single server and cancel its reconnect loop.
   */
  disconnect(name: string): void {
    const entry = this.servers.get(name);
    if (!entry) return;
    entry.revision++;

    this.cancelReconnect(entry);
    const attempt = entry.attempt;
    entry.attempt = undefined;
    if (attempt) {
      attempt.cancel();
      this.closeAttempt(entry, attempt);
    }
    this.closeClient(entry);
    if (entry.published && entry.definitionFingerprints.size) this.toolCatalogRevision++;
    entry.published = false;
    entry.definitionFingerprints.clear();
    entry.description = undefined;
    entry.instructions = undefined;
    entry.tools = [];
    entry.status = { state: 'disconnected' };
  }

  /**
   * Disconnect all servers and release all resources.
   */
  disconnectAll(): void {
    this._disposed = true;
    for (const name of this.servers.keys()) {
      this.disconnect(name);
    }
  }

  /** After disconnectAll, wait until cancelled transport preparation has unwound. */
  async whenSettled(): Promise<void> {
    while (this.preparations.size) await Promise.allSettled([...this.preparations]);
  }

  /**
   * Disconnect then reconnect a server.
   */
  async restart(name: string): Promise<void> {
    this.disconnect(name);
    await this.connect(name);
  }

  /**
   * Remove a server entirely — disconnect and deregister.
   * No-op if the server is not registered.
   */
  removeServer(name: string): void {
    this.disconnect(name);
    this.servers.delete(name);
  }

  /**
   * Enable or disable a server by name.
   *
   * - `enabled = true` → connect the server (no-op if already connected).
   * - `enabled = false` → disconnect the server without removing its config,
   *    so it can be re-enabled later.
   */
  async toggle(name: string, enabled: boolean): Promise<void> {
    const entry = this.servers.get(name);
    if (!entry) {
      throw new Error(`MCP server "${name}" is not registered`);
    }

    if (enabled) {
      if (entry.status.state !== 'connected') {
        await this.connect(name);
      }
    } else {
      this.disconnect(name);
    }
  }

  /**
   * Atomically replace the managed server set.
   *
   * - Servers present in `configs` but not currently registered → added and connected.
   * - Servers currently registered but absent from `configs` → disconnected and removed.
   * - Servers present in both but with a changed config → restarted with new config.
   * - Servers present in both with identical config → untouched.
   *
   * Returns lists of server names that were added and removed.
   */
  async setServers(
    configs: Record<string, Record<string, unknown>>,
  ): Promise<{ added: string[]; removed: string[]; errors: Record<string, string> }> {
    if (this._disposed) throw new Error('MCP connection manager is disposed');
    const added: string[] = [];
    const removed: string[] = [];
    const errors: Record<string, string> = {};

    // Determine removed servers
    for (const name of this.servers.keys()) {
      if (!(name in configs)) {
        this.removeServer(name);
        removed.push(name);
      }
    }

    // Determine added or updated servers
    for (const [name, config] of Object.entries(configs)) {
      if (this._disposed) throw new Error('MCP connection manager is disposed');
      const existing = this.servers.get(name);

      if (!existing) {
        // New server — register and connect
        this.addServer(name, config);
        added.push(name);
        await this.connect(name).catch((err: unknown) => {
          errors[name] = err instanceof Error ? err.message : String(err);
        });
      } else {
        // Check if config changed (shallow JSON comparison)
        const configChanged = JSON.stringify(existing.config) !== JSON.stringify(config);
        if (configChanged) {
          // Update config and restart
          existing.config = config;
          existing.configRevision++;
          await this.restart(name).catch((err: unknown) => {
            errors[name] = err instanceof Error ? err.message : String(err);
          });
        }
        // Unchanged — leave as-is
      }
    }

    return { added, removed, errors };
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * Get the live status for a single server.
   */
  getStatus(name: string): McpServerLiveStatus | undefined {
    return this.servers.get(name)?.status;
  }

  /**
   * Get statuses for all servers.
   */
  getAllStatuses(): Map<string, McpServerLiveStatus> {
    const map = new Map<string, McpServerLiveStatus>();
    for (const [name, entry] of this.servers) {
      map.set(name, entry.status);
    }
    return map;
  }

  /**
   * Get connection statuses for the init message.
   */
  getStatuses(): McpServerConnectionStatus[] {
    const result: McpServerConnectionStatus[] = [];
    for (const [name, entry] of this.servers) {
      if (entry.status.state === 'connected') {
        result.push({ name, status: 'connected' });
      } else {
        const error = entry.status.state === 'disconnected'
          ? entry.status.lastError
          : entry.status.state === 'failed'
            ? entry.status.error
            : undefined;
        result.push({ name, status: 'failed', error });
      }
    }
    return result;
  }

  /**
   * Whether a server is currently connected.
   */
  isConnected(name: string): boolean {
    const entry = this.servers.get(name);
    return entry?.status.state === 'connected' && entry.client != null;
  }

  /**
   * Names of all registered servers.
   */
  serverNames(): string[] {
    return Array.from(this.servers.keys());
  }

  /** Changes only when published tool definitions or explicit availability change. */
  getToolCatalogRevision(): number { return this.toolCatalogRevision; }

  /** Includes retired snapshots without retaining them after the owner drops its references. */
  ownsTool(tool: Tool): boolean { return this.issuedTools.has(tool); }

  // -------------------------------------------------------------------------
  // Tool bridging
  // -------------------------------------------------------------------------

  /**
   * Return all tools from all connected servers as SDK `Tool[]` objects
   * suitable for the query loop.
   *
   * Tools are wrapped with auto-reconnect: if a call fails due to a
   * disconnected transport, the manager attempts a single reconnect
   * before returning the error.
   */
  getBridgedTools(): Tool[] {
    const allTools: Tool[] = [];
    for (const [, entry] of this.servers) {
      if (!entry.published) continue;

      for (const mcpTool of entry.tools) {
        const tool = this.createBridgedTool(entry, mcpTool);
        this.issuedTools.add(tool);
        allTools.push(tool);
      }
    }
    assertUniqueMcpToolNames(allTools);
    return allTools;
  }

  /**
   * Create a single bridged Tool that routes to the MCP server and
   * includes auto-reconnect logic.
   */
  private createBridgedTool(
    owner: ServerEntry,
    mcpTool: McpToolDefinition,
  ): Tool {
    const serverName = owner.name;
    const configRevision = owner.configRevision;
    const fingerprint = owner.definitionFingerprints.get(mcpTool.name);
    const fullName = `mcp__${normalizeNameForMCP(serverName)}__${normalizeNameForMCP(mcpTool.name)}`;
    const manager = this;
    const isCurrent = (entry: ServerEntry | undefined): entry is ServerEntry =>
      !manager._disposed && entry === owner && entry.configRevision === configRevision &&
      fingerprint !== undefined && entry.definitionFingerprints.get(mcpTool.name) === fingerprint;
    const staleDefinition = (attempted = false): ToolResult => {
      log.warn('MCP call refused: tool definition changed or was removed', { server: serverName, tool: mcpTool.name,
        stage: attempted ? 'after-reconnect' : 'before-execution' });
      return { isError: true,
        content: `MCP tool "${mcpTool.name}" changed or is no longer available on "${serverName}". Refresh its definition before retrying. ` +
          (attempted ? 'The call was not retried under the new definition. Check whether the earlier attempt took effect before repeating it.'
            : 'The stale call was not executed.') };
    };

    return {
      name: fullName,
      mcpSource: {
        server: serverName,
        name: mcpTool.name,
        description: owner.description,
        instructions: owner.instructions,
        toolDescription: mcpTool.description ?? '',
      },
      description: truncateDescription(mcpTool.description ?? ''),
      inputSchema: mcpTool.inputSchema,
      permissionLevel: 'execute' as const,

      async execute(
        input: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<ToolResult> {
        const entry = manager.servers.get(serverName);
        if (!isCurrent(entry)) return staleDefinition();

        const revision = entry.revision;
        // Attempt tool call
        let result = await manager.attemptToolCall(entry, mcpTool.name, input, ctx.abortSignal);

        // If the call failed due to disconnection, attempt one reconnect
        if (result.isError && !ctx.abortSignal?.aborted && !manager._disposed && entry.revision === revision &&
            manager.servers.get(serverName) === entry && manager.isTransportDead(entry)) {
          log.warn('server disconnected during tool call, attempting reconnect', { server: serverName, tool: mcpTool.name });

          const reconnected = await manager.tryReconnect(entry);
          if (reconnected && !isCurrent(manager.servers.get(serverName))) return staleDefinition(true);
          if (reconnected && (mcpTool.annotations?.readOnlyHint === true || mcpTool.annotations?.idempotentHint === true)) {
            result = await manager.attemptToolCall(entry, mcpTool.name, input, ctx.abortSignal);
          } else if (reconnected) {
            log.warn('MCP connection restored without replaying an uncertain operation', { server: serverName, tool: mcpTool.name });
            result = { ...result, content: `${result.content}\nThe connection was restored. This operation was not replayed; check its effects before retrying.` };
          } else {
            // Start background reconnect loop for future calls
            manager.startReconnectLoop(serverName);
          }
        }

        return result;
      },
    };
  }

  /**
   * Attempt a single tool call on a server entry.
   */
  private async attemptToolCall(
    entry: ServerEntry,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (!entry.client) {
      return {
        content: `MCP server "${entry.name}" is not connected.`,
        isError: true,
      };
    }

    try {
      const result = await entry.client.callTool(toolName, args, signal);
      return formatCallToolResult(result.content, result.isError);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: `MCP tool error (${entry.name}/${toolName}): ${msg}`,
        isError: true,
      };
    }
  }

  /**
   * Check if the transport for a server is dead (disconnected/closed).
   */
  private isTransportDead(entry: ServerEntry): boolean {
    if (!entry.transport) return true;
    return !entry.transport.connected;
  }

  /**
   * Attempt to reconnect a single server (synchronous single attempt).
   * Returns true if reconnection succeeded.
   */
  private async tryReconnect(entry: ServerEntry): Promise<boolean> {
    if (this._disposed || this.servers.get(entry.name) !== entry) return false;
    try {
      await this.connect(entry.name);
      if (!this.isConnected(entry.name)) return false;
      log.info('server reconnected', { server: entry.name, tools: entry.tools.length });
      return true;
    } catch (error) {
      if (!this._disposed && this.servers.get(entry.name) === entry) {
        log.warn('reconnect failed', { server: entry.name, error: String(error) });
      }
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Background reconnection loop
  // -------------------------------------------------------------------------

  /**
   * Start a background exponential-backoff reconnection loop for a server.
   * The loop exits when the server connects successfully or is disconnected
   * explicitly (i.e., manager.disconnect() is called).
   *
   * Backoff: 1s → 2s → 4s → … capped at 60s.
   */
  startReconnectLoop(name: string): void {
    const entry = this.servers.get(name);
    if (!entry || this._disposed) return;

    // Don't start a second loop
    if (entry.reconnecting) return;
    entry.reconnecting = true;

    this.scheduleReconnectAttempt(entry);
  }

  /**
   * Schedule the next reconnect attempt for a server.
   */
  private scheduleReconnectAttempt(entry: ServerEntry): void {
    if (this._disposed) return;

    const retryAt = Date.now() + entry.backoffMs;

    // Update status to reflect the pending retry
    const prevError = entry.status.state === 'disconnected'
      ? (entry.status.lastError ?? 'connection lost')
      : entry.status.state === 'failed'
        ? entry.status.error
        : 'connection lost';

    entry.status = {
      state: 'failed',
      error: prevError,
      retryAt,
    };

    const timer = setTimeout(async () => {
      if (this._disposed || !entry.reconnecting || entry.reconnectTimer !== timer) return;

      entry.status = { state: 'connecting' };

      const success = await this.tryReconnect(entry);
      if (this._disposed || entry.reconnectTimer !== timer) return;
      if (success) {
        entry.reconnecting = false;
        entry.reconnectTimer = null;
        return;
      }

      // Exponential backoff
      entry.backoffMs = Math.min(
        entry.backoffMs * BACKOFF_MULTIPLIER,
        MAX_BACKOFF_MS,
      );

      // Schedule next attempt
      if (entry.reconnecting && !this._disposed) {
        this.scheduleReconnectAttempt(entry);
      }
    }, entry.backoffMs);
    entry.reconnectTimer = timer;
  }

  /**
   * Cancel the reconnect loop for a server.
   */
  private cancelReconnect(entry: ServerEntry): void {
    entry.reconnecting = false;
    if (entry.reconnectTimer != null) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
  }
}

function fingerprintDefinition(tool: McpToolDefinition, client: McpClient): string {
  const content = JSON.stringify({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema,
    annotations: tool.annotations ?? null, descriptionOfService: client.getServerInfo()?.description ?? '',
    instructions: client.getInstructions() ?? '' }, (_key, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
  return createHash('sha256').update(content).digest('hex');
}

// ---------------------------------------------------------------------------
// Transport factory
// ---------------------------------------------------------------------------

/**
 * Create a transport from a server config record.
 * Returns null for unsupported or invalid configs.
 */
function createTransport(
  name: string,
  config: Record<string, unknown>,
): McpTransport | null {
  const type = (config.type as string | undefined) ?? 'stdio';

  switch (type) {
    case 'stdio': {
      const command = config.command as string | undefined;
      if (!command) {
        log.warn('MCP server has type=stdio but no command', { server: name });
        return null;
      }
      return new StdioTransport({
        command,
        args: config.args as string[] | undefined,
        env: config.env as Record<string, string> | undefined,
        cwd: config.cwd as string | undefined,
      });
    }

    case 'sse': {
      const url = config.url as string | undefined;
      if (!url) {
        log.warn('MCP server has type=sse but no url', { server: name });
        return null;
      }
      return new SSETransport({
        url,
        headers: config.headers as Record<string, string> | undefined,
      });
    }

    case 'http': {
      const url = config.url as string | undefined;
      if (!url) {
        log.warn('MCP server has type=http but no url', { server: name });
        return null;
      }
      return new HttpTransport({
        url,
        headers: config.headers as Record<string, string> | undefined,
      });
    }

    default:
      log.warn('unsupported MCP transport type', { server: name, type });
      return null;
  }
}

// ---------------------------------------------------------------------------
// Shared MCP result formatter
// ---------------------------------------------------------------------------

export { formatCallToolResult } from './bridge.js';

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

/** Options for createMcpConnectionManager. */
export interface CreateMcpConnectionManagerOptions {
  /** Handles user-input (elicitation) requests from MCP servers. */
  onElicitation?: McpElicitationHandler;
}

/**
 * Create a McpConnectionManager from an mcpServers config record,
 * skipping SDK-type configs (those are handled in-process).
 *
 * @param mcpServers - The mcpServers record from Options
 * @param options - Additional options (e.g. elicitation handler)
 * @returns A new McpConnectionManager with all external servers registered
 */
export function createMcpConnectionManager(
  mcpServers: Record<string, unknown> | undefined,
  options?: CreateMcpConnectionManagerOptions,
): McpConnectionManager {
  const mgr = new McpConnectionManager();
  if (options?.onElicitation) {
    mgr.setElicitationHandler(options.onElicitation);
  }
  if (!mcpServers) return mgr;

  for (const [name, config] of Object.entries(mcpServers)) {
    if (!config || typeof config !== 'object') continue;
    const cfg = config as Record<string, unknown>;
    // Skip SDK-type configs — handled by extractSdkMcpTools()
    if (cfg.type === 'sdk') continue;
    mgr.addServer(name, cfg);
  }

  return mgr;
}
