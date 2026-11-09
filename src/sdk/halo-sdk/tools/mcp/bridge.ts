/**
 * @module tools/mcp/bridge
 * Bridges MCP server tools into the query loop's Tool interface.
 *
 * Supports two modes:
 *
 * 1. **SDK (in-process)** — servers created by `createSdkMcpServer()`.
 *    Tools are resolved synchronously via `extractSdkMcpTools()`.
 *
 * 2. **External (stdio/sse/http)** — servers spawned or connected over the
 *    network. Tools are resolved asynchronously via `connectExternalMcpServers()`.
 *    Each server is connected, initialized (MCP handshake), and its tools
 *    are discovered and bridged into `Tool` instances.
 *
 * Tool names use the SDK compatibility convention: `mcp__{serverName}__{toolName}`.
 *
 * @license MIT
 */

import { getLogger } from '../../utils/logger.js';
import { decodedImageBytes, MAX_IMAGE_BASE64_CHARS, MAX_IMAGE_BYTES } from '../../utils/image-data.js';
import type { Tool, ToolResult, ToolContext, ToolResultImage } from '../../types/tool.js';
import type { McpSdkServerConfigWithInstance, SdkMcpServerInstance } from './sdk-server.js';
import { McpClient, type McpToolDefinition } from './client.js';
import { StdioTransport, SSETransport, HttpTransport } from './transports.js';
import type { McpTransport } from './jsonrpc.js';
import { zodToJsonSchema } from './zod-to-json-schema.js';

const log = getLogger('MCP:Bridge');

// ---------------------------------------------------------------------------
// MCP tool name conventions
// ---------------------------------------------------------------------------

const MAX_MCP_DESCRIPTION_LENGTH = 2048;

/** Truncate an MCP tool description to avoid wasting context tokens. */
export function truncateDescription(desc: string): string {
  if (desc.length <= MAX_MCP_DESCRIPTION_LENGTH) return desc;
  return desc.slice(0, MAX_MCP_DESCRIPTION_LENGTH) + '... [truncated]';
}

/**
 * Normalize a name segment for use in MCP tool names.
 * Replaces any character outside `[a-zA-Z0-9_-]` with underscore.
 */
export function normalizeNameForMCP(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Build the namespaced tool name for an MCP tool.
 * Convention: `mcp__{server-name}__{tool-name}`
 *
 * Each segment is restricted to the provider's identifier alphabet.
 * This transformation does not shorten names or resolve collisions.
 */
function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${normalizeNameForMCP(serverName)}__${normalizeNameForMCP(toolName)}`;
}

/** Refuse ambiguous routing before a name-keyed pool can replace either tool. */
export class McpToolIdentityError extends Error {}

export function assertUniqueMcpToolNames(tools: readonly Tool[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      log.warn('MCP tool identity collision', { name: tool.name });
      throw new McpToolIdentityError(`MCP tool identity collision: ${tool.name}`);
    }
    names.add(tool.name);
  }
}

// =========================================================================
// Part 1: SDK (in-process) MCP servers
// =========================================================================

/**
 * Extract all tools from an SDK MCP server and wrap them as SDK `Tool`
 * objects that can be added to the query loop.
 *
 * Supports two instance formats:
 * - SDK MCP instances (created by our `createSdkMcpServer`): have `listTools()`
 * - External SDK instances: store tools in `_registeredTools` without a `listTools()` method
 *
 * @param serverConfig - The SDK server config with live instance
 * @returns Array of Tool objects
 */
export function bridgeSdkMcpTools(serverConfig: { name: string; instance: unknown; description?: string; instructions?: string }, sourceServer = serverConfig.name): Tool[] {
  const { name: serverName } = serverConfig;
  const instance = serverConfig.instance as SdkMcpServerInstance;
  const source = {
    server: sourceServer,
    description: serverConfig.description ?? instance.description,
    instructions: serverConfig.instructions ?? instance.instructions,
  };

  // SDK MCP instance: has listTools()
  if (typeof (instance as unknown as Record<string, unknown>).listTools === 'function') {
    const mcpTools = instance.listTools();
    const tools = mcpTools.map((mcpTool) =>
      createSdkBridgedTool(
        serverName,
        mcpTool as {
          name: string;
          description: string;
          inputSchema: Record<string, unknown>;
          annotations?: Record<string, unknown>;
        },
        instance,
        source,
      ),
    );
    assertUniqueMcpToolNames(tools);
    return tools;
  }

  // External SDK instance: tools stored in _registeredTools
  const registeredTools = (instance as unknown as Record<string, unknown>)._registeredTools;
  if (registeredTools && typeof registeredTools === 'object') {
    const tools = Object.entries(registeredTools as Record<string, unknown>)
      .filter(([, def]) => (def as Record<string, unknown>)?.enabled !== false)
      .map(([toolName, def]) =>
        createRegisteredSdkTool(serverName, toolName, def as RegisteredSdkTool, source),
      );
    assertUniqueMcpToolNames(tools);
    return tools;
  }

  return [];
}

/**
 * Whether an MCP server declared this tool read-only.
 *
 * `readOnlyHint` is the only thing a remote server tells us about side
 * effects, so silence has to mean unsafe: we cannot see the state two calls
 * from that server might race over.
 */
function mcpConcurrencySafe(annotations?: Record<string, unknown>): boolean {
  return annotations?.readOnlyHint === true;
}

/**
 * Create a single bridged Tool from an SDK MCP tool definition.
 */
function createSdkBridgedTool(
  serverName: string,
  mcpTool: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  },
  instance: SdkMcpServerInstance,
  source: Omit<NonNullable<Tool['mcpSource']>, 'name' | 'toolDescription'>,
): Tool {
  const fullName = mcpToolName(serverName, mcpTool.name);

  return {
    name: fullName,
    mcpSource: { ...source, name: mcpTool.name, toolDescription: mcpTool.description },
    description: truncateDescription(mcpTool.description),
    inputSchema: mcpTool.inputSchema,
    // MCP tools are assumed to require execution-level permissions since
    // their capabilities are unknown to the SDK.
    permissionLevel: 'execute' as const,
    isConcurrencySafe: () => mcpConcurrencySafe(mcpTool.annotations),

    async execute(
      input: Record<string, unknown>,
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const result = await instance.callTool(mcpTool.name, input, { signal: ctx.abortSignal });

      if (!result) {
        return {
          content: `MCP tool "${mcpTool.name}" not found on server "${serverName}".`,
          isError: true,
        };
      }

      return formatCallToolResult(result.content, result.isError);
    },
  };
}

// =========================================================================
// External SDK instance compatibility
// =========================================================================

/**
 * Shape of a tool entry in an external SDK's internal `_registeredTools` map.
 *
 * NOTE: `inputSchema` here is a **Zod schema object**, NOT a JSON schema.
 * The MCP SDK converts it to JSON schema in its `tools/list` handler via
 * `normalizeObjectSchema` + `toJsonSchemaCompat`. Use `zodToJsonSchema()`
 * before passing it to the Tool interface.
 */
interface RegisteredSdkTool {
  description?: string;
  /** Zod schema — must be converted to JSON schema via zodToJsonSchema() before use. */
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
  enabled?: boolean;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<{
    content?: Array<{ type: string; [key: string]: unknown }>;
    isError?: boolean;
  }>;
}

/**
 * Create a bridged Tool from an external SDK registered tool entry.
 */
function createRegisteredSdkTool(
  serverName: string,
  toolName: string,
  def: RegisteredSdkTool,
  source: Omit<NonNullable<Tool['mcpSource']>, 'name' | 'toolDescription'>,
): Tool {
  const fullName = mcpToolName(serverName, toolName);

  return {
    name: fullName,
    mcpSource: { ...source, name: toolName, toolDescription: def.description ?? '' },
    description: truncateDescription(def.description ?? ''),
    // Convert Zod schema to JSON schema — external SDK instances store Zod objects in _registeredTools.
    inputSchema: zodToJsonSchema(def.inputSchema),
    permissionLevel: 'execute' as const,
    isConcurrencySafe: () => mcpConcurrencySafe(def.annotations),

    async execute(
      input: Record<string, unknown>,
      ctx: ToolContext,
    ): Promise<ToolResult> {
      try {
        const result = await def.handler(input, { signal: ctx.abortSignal });
        if (!result) {
          return {
            content: `MCP tool "${toolName}" returned no result.`,
            isError: true,
          };
        }
        return formatCallToolResult(result.content ?? [], result.isError);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: `MCP tool "${toolName}" failed: ${msg}`, isError: true };
      }
    },
  };
}

// =========================================================================
// Part 2: External MCP servers (stdio/sse/http)
// =========================================================================

/** A connected external MCP server with its bridged tools. */
interface ConnectedExternalServer {
  name: string;
  client: McpClient;
  tools: Tool[];
}

/** Per-server connection status included in the init system message. */
export interface McpServerConnectionStatus {
  name: string;
  status: 'connected' | 'failed';
  error?: string;
}

/**
 * Result of connecting external MCP servers.
 * Holds the bridged tools and a disconnect function for cleanup.
 */
export interface ExternalMcpConnection {
  /** All bridged tools from connected external MCP servers. */
  tools: Tool[];
  /** Per-server connection statuses. */
  serverStatuses: McpServerConnectionStatus[];
  /** Disconnect all external MCP servers. Must be called during cleanup. */
  disconnect: () => void;
}

/**
 * Connect to all external MCP servers (stdio/sse/http) in the config,
 * perform MCP handshake, discover tools, and bridge them.
 *
 * Servers that fail to connect are logged and skipped — they do not
 * prevent other servers from connecting.
 *
 * @param mcpServers - The mcpServers record from Options
 * @returns Bridged tools and a disconnect function
 */
export async function connectExternalMcpServers(
  mcpServers: Record<string, unknown> | undefined,
): Promise<ExternalMcpConnection> {
  if (!mcpServers) return { tools: [], serverStatuses: [], disconnect: () => {} };

  const connected: ConnectedExternalServer[] = [];
  const serverStatuses: McpServerConnectionStatus[] = [];

  for (const [name, config] of Object.entries(mcpServers)) {
    if (!config || typeof config !== 'object') continue;
    const cfg = config as Record<string, unknown>;

    // Skip SDK-type configs — handled by extractSdkMcpTools()
    if (cfg.type === 'sdk') continue;

    try {
      const server = await connectSingleExternalServer(name, cfg);
      if (server) {
        connected.push(server);
        serverStatuses.push({ name, status: 'connected' });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('failed to connect MCP server', { server: name, err: msg });
      serverStatuses.push({ name, status: 'failed', error: msg });
    }
  }

  const allTools = connected.flatMap((s) => s.tools);

  const disconnect = () => {
    for (const server of connected) {
      try {
        server.client.close();
      } catch {
        // Ignore close errors during cleanup
      }
    }
    connected.length = 0;
  };

  try {
    assertUniqueMcpToolNames(allTools);
  } catch (error) {
    disconnect();
    throw error;
  }
  return { tools: allTools, serverStatuses, disconnect };
}

/**
 * Connect to a single external MCP server, initialize it, and bridge its tools.
 */
async function connectSingleExternalServer(
  name: string,
  config: Record<string, unknown>,
): Promise<ConnectedExternalServer | null> {
  const type = (config.type as string | undefined) ?? 'stdio';

  let transport: McpTransport;

  switch (type) {
    case 'stdio': {
      const command = config.command as string | undefined;
      if (!command) {
        log.warn('MCP server has type=stdio but no command', { server: name });
        return null;
      }
      transport = new StdioTransport({
        command,
        args: config.args as string[] | undefined,
        env: config.env as Record<string, string> | undefined,
        cwd: config.cwd as string | undefined,
      });
      break;
    }

    case 'sse': {
      const url = config.url as string | undefined;
      if (!url) {
        log.warn('MCP server has type=sse but no url', { server: name });
        return null;
      }
      transport = new SSETransport({
        url,
        headers: config.headers as Record<string, string> | undefined,
      });
      break;
    }

    case 'http': {
      const url = config.url as string | undefined;
      if (!url) {
        log.warn('MCP server has type=http but no url', { server: name });
        return null;
      }
      transport = new HttpTransport({
        url,
        headers: config.headers as Record<string, string> | undefined,
      });
      break;
    }

    default:
      log.warn('unsupported MCP transport type', { server: name, type });
      return null;
  }

  // Connect transport
  await transport.connect();

  // MCP handshake + tool discovery
  const client = new McpClient(transport, name);
  try {
    await client.initialize();
  } catch (err: unknown) {
    // If initialize fails, close the transport and skip
    transport.close();
    throw err;
  }

  // Bridge discovered tools
  const mcpToolDefs = client.getTools();
  const tools = mcpToolDefs.map((mcpTool) =>
    createExternalBridgedTool(name, mcpTool, client),
  );

  return { name, client, tools };
}

/**
 * Create a bridged Tool from an external MCP tool definition.
 */
function createExternalBridgedTool(
  serverName: string,
  mcpTool: McpToolDefinition,
  client: McpClient,
): Tool {
  const fullName = mcpToolName(serverName, mcpTool.name);

  return {
    name: fullName,
    mcpSource: {
      server: serverName,
      name: mcpTool.name,
      description: client.getServerInfo()?.description,
      instructions: client.getInstructions(),
      toolDescription: mcpTool.description ?? '',
    },
    description: truncateDescription(mcpTool.description ?? ''),
    inputSchema: mcpTool.inputSchema,
    permissionLevel: 'execute' as const,
    isConcurrencySafe: () => mcpConcurrencySafe(mcpTool.annotations),

    async execute(
      input: Record<string, unknown>,
      _ctx: ToolContext,
    ): Promise<ToolResult> {
      const result = await client.callTool(mcpTool.name, input);
      return formatCallToolResult(result.content, result.isError);
    },
  };
}

// =========================================================================
// Shared helpers
// =========================================================================

/** Maximum images carried by a single MCP tool result; extras are dropped. */
const MAX_MCP_IMAGES_PER_RESULT = 5;

/**
 * Convert MCP CallToolResult content blocks to a ToolResult. Image blocks are
 * carried in `images` for structured delivery to the model, with a text
 * placeholder kept for providers without image input.
 *
 * Exported for unit tests only.
 */
export function formatCallToolResult(
  content: Array<{ type: string; [key: string]: unknown }>,
  isError?: boolean,
): ToolResult {
  const textParts: string[] = [];
  const images: ToolResultImage[] = [];
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
    } else if (block.type === 'image') {
      const mimeType = block.mimeType;
      if (typeof block.data !== 'string') {
        textParts.push(`[Image dropped: invalid or missing image data (${JSON.stringify(mimeType ?? null)})]`);
        log.warn('MCP image rejected: invalid data type', { mimeType: mimeType ?? null });
        continue;
      }
      const imageBytes = block.data.length <= MAX_IMAGE_BASE64_CHARS ? decodedImageBytes(block.data) : null;
      if (mimeType !== 'image/jpeg' && mimeType !== 'image/png' && mimeType !== 'image/gif' && mimeType !== 'image/webp') {
        textParts.push(`[Image dropped: unsupported or missing MIME type ${JSON.stringify(mimeType ?? null)}]`);
        log.warn('MCP image rejected: unsupported MIME type', { mimeType: mimeType ?? null });
      } else if (block.data.length > MAX_IMAGE_BASE64_CHARS || (imageBytes !== null && imageBytes > MAX_IMAGE_BYTES)) {
        textParts.push(`[Image dropped: ${mimeType} image exceeds 5 MB of decoded data]`);
        log.warn('MCP image rejected: size limit', { mimeType, base64Chars: block.data.length, limitBytes: MAX_IMAGE_BYTES });
      } else if (imageBytes === null) {
        textParts.push(`[Image dropped: invalid base64 image data (${mimeType})]`);
        log.warn('MCP image rejected: invalid base64', { mimeType, base64Chars: block.data.length });
      } else if (images.length >= MAX_MCP_IMAGES_PER_RESULT) {
        textParts.push('[Image dropped: more than 5 images in one result]');
        log.warn('MCP image rejected: per-result count limit', { mimeType, limit: MAX_MCP_IMAGES_PER_RESULT });
      } else {
        images.push({ mimeType, data: block.data });
        textParts.push(`[Image: ${mimeType}]`);
      }
    } else {
      // Other block types — serialize as JSON
      textParts.push(JSON.stringify(block));
    }
  }

  return {
    content: textParts.join('\n'),
    isError: isError ?? false,
    ...(images.length > 0 ? { images } : {}),
  };
}

// =========================================================================
// SDK MCP detection and extraction (synchronous)
// =========================================================================

/**
 * Check if a server config is an SDK-type config with a live instance.
 */
export function isSdkMcpServerConfig(config: unknown): config is McpSdkServerConfigWithInstance {
  if (!config || typeof config !== 'object') return false;
  const obj = config as Record<string, unknown>;
  return obj.type === 'sdk' && 'instance' in obj && obj.instance != null;
}

/**
 * Extract all bridged tools from SDK-type MCP server configs.
 *
 * This is synchronous — SDK servers are in-process and don't require
 * network connections. For external servers (stdio/sse/http), use
 * `connectExternalMcpServers()` instead.
 *
 * @param mcpServers - The mcpServers record from Options
 * @returns Array of bridged Tool objects
 */
export function extractSdkMcpTools(
  mcpServers: Record<string, unknown> | undefined,
): Tool[] {
  if (!mcpServers) return [];

  const tools: Tool[] = [];
  for (const [name, config] of Object.entries(mcpServers)) {
    if (isSdkMcpServerConfig(config)) {
      tools.push(...bridgeSdkMcpTools(config, name));
    }
  }
  assertUniqueMcpToolNames(tools);
  return tools;
}
