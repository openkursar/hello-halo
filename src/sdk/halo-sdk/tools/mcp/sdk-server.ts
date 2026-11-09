/**
 * @module tools/mcp/sdk-server
 * In-process MCP SDK server — implements `tool()` and `createSdkMcpServer()`.
 *
 * These two functions are the primary way consumers define custom MCP
 * tools that run in the same process as the SDK. They create tool definitions
 * and wrap them in a server config that can be passed via `options.mcpServers`.
 *
 * The SDK query loop extracts these tools at session startup and routes
 * `tool_use` calls to the matching handler — no MCP transport needed.
 *
 * @license MIT
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal CallToolResult — describes the content and error state of a tool invocation.
 * Defined locally to keep this package free of extra dependencies.
 */
export interface CallToolResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string } | { type: string; [key: string]: unknown }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/**
 * Tool annotations for MCP tools.
 */
export interface ToolAnnotations {
  /** Human-readable title for the tool */
  title?: string;
  /** Whether the tool's output may be destructive */
  destructiveHint?: boolean;
  /** Whether the tool has side effects */
  idempotentHint?: boolean;
  /** Whether the tool opens a URI */
  openWorldHint?: boolean;
  /** Whether the tool only reads data */
  readOnlyHint?: boolean;
}

/**
 * Zod-like raw shape — we accept any object whose values have `_output`.
 * Works with both Zod 3 and Zod 4.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyZodRawShape = Record<string, any>;

/**
 * Infer the output type from a Zod raw shape.
 */
export type InferShape<T extends AnyZodRawShape> = {
  [K in keyof T]: T[K] extends { _output: infer O } ? O : never;
} & {};

/**
 * An MCP tool definition as returned by `tool()`.
 */
export interface SdkMcpToolDefinition<Schema extends AnyZodRawShape = AnyZodRawShape> {
  name: string;
  description: string;
  inputSchema: Schema;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
  handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>;
}

/**
 * Options for `createSdkMcpServer()`.
 */
export interface CreateSdkMcpServerOptions {
  name: string;
  version?: string;
  description?: string;
  instructions?: string;
  tools?: Array<SdkMcpToolDefinition<any>>;
}

/**
 * Base SDK server config (serializable — no live instance).
 */
export interface McpSdkServerConfig {
  type: 'sdk';
  name: string;
  description?: string;
  instructions?: string;
}

/**
 * SDK server config with a live server instance (not serializable).
 * This is what `createSdkMcpServer()` returns and what consumers pass
 * into `options.mcpServers`.
 */
export interface McpSdkServerConfigWithInstance extends McpSdkServerConfig {
  /**
   * The server instance. A lightweight wrapper that holds
   * the tool definitions and routes calls.
   */
  instance: SdkMcpServerInstance;
}

/**
 * The live SDK MCP server instance.
 * Holds tool definitions and can execute them by name.
 */
export interface SdkMcpServerInstance {
  /** Server name */
  readonly name: string;
  /** Server version */
  readonly version: string;
  readonly description?: string;
  readonly instructions?: string;
  /** Registered tool definitions */
  readonly tools: ReadonlyArray<SdkMcpToolDefinition>;
  /**
   * Execute a tool by name.
   * @returns The tool result, or undefined if the tool is not found.
   */
  callTool(name: string, args: Record<string, unknown>, extra?: { signal?: AbortSignal }): Promise<CallToolResult | undefined>;
  /**
   * List all tool schemas (for LLM tool_use definitions).
   */
  listTools(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: ToolAnnotations;
  }>;
}

// ---------------------------------------------------------------------------
// tool() — factory function
// ---------------------------------------------------------------------------

/**
 * Create an MCP tool definition.
 *
 * This is the primary way consumers define custom tools. The returned
 * definition is passed to `createSdkMcpServer()`.
 *
 * @param name - Unique tool name (MCP convention: lowercase with underscores)
 * @param description - Human-readable description shown to the LLM
 * @param inputSchema - Zod raw shape defining the tool's parameters
 * @param handler - Async function that executes the tool and returns CallToolResult
 * @param extras - Optional metadata (annotations, searchHint, alwaysLoad)
 * @returns An SdkMcpToolDefinition
 *
 * @example
 * ```ts
 * import { z } from 'zod';
 * import { tool, createSdkMcpServer } from '@hello-halo/agent-sdk';
 *
 * const myTool = tool(
 *   'my_tool',
 *   'Does something useful',
 *   { input: z.string() },
 *   async (args) => ({
 *     content: [{ type: 'text', text: `Result: ${args.input}` }],
 *   })
 * );
 *
 * const server = createSdkMcpServer({ name: 'my-server', tools: [myTool] });
 * ```
 */
export function tool<Schema extends AnyZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
  extras?: {
    annotations?: ToolAnnotations;
    searchHint?: string;
    alwaysLoad?: boolean;
  },
): SdkMcpToolDefinition<Schema> {
  const meta: Record<string, unknown> = {};
  if (extras?.searchHint) meta.searchHint = extras.searchHint;
  if (extras?.alwaysLoad) meta.alwaysLoad = extras.alwaysLoad;

  return {
    name,
    description,
    inputSchema,
    annotations: extras?.annotations,
    _meta: Object.keys(meta).length > 0 ? meta : undefined,
    handler,
  };
}

// ---------------------------------------------------------------------------
// createSdkMcpServer() — server factory
// ---------------------------------------------------------------------------

import { zodToJsonSchema } from './zod-to-json-schema.js';

/**
 * Create an in-process MCP server from tool definitions.
 *
 * Returns a `McpSdkServerConfigWithInstance` that can be passed to
 * `options.mcpServers` in query() or createSession().
 *
 * The SDK extracts tools from this config at session startup, creates
 * bridged Tool objects, and routes tool_use calls to the handler.
 *
 * @param options - Server name, version, and tool definitions
 * @returns An MCP SDK server config with a live instance
 *
 * @example
 * ```ts
 * const server = createSdkMcpServer({
 *   name: 'my-server',
 *   version: '1.0.0',
 *   tools: [myTool1, myTool2],
 * });
 *
 * // Pass to SDK session
 * const session = await createSession({
 *   provider: myProvider,
 *   mcpServers: { 'my-server': server },
 * });
 * ```
 */
export function createSdkMcpServer(options: CreateSdkMcpServerOptions): McpSdkServerConfigWithInstance {
  const { name, version = '1.0.0', description, instructions, tools: toolDefs = [] } = options;

  const instance: SdkMcpServerInstance = {
    name,
    version,
    description,
    instructions,
    tools: toolDefs,

    async callTool(toolName: string, args: Record<string, unknown>, extra?: { signal?: AbortSignal }): Promise<CallToolResult | undefined> {
      const def = toolDefs.find((t) => t.name === toolName);
      if (!def) return undefined;

      // Execute the handler with the provided args
      // The handler expects InferShape<Schema>, but at runtime we pass the
      // raw JSON-parsed args from the LLM. Zod runtime validation is NOT
      // enforced here.
      return def.handler(args as any, extra ?? {});
    },

    listTools(): Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      annotations?: ToolAnnotations;
    }> {
      return toolDefs.map((def) => ({
        name: def.name,
        description: def.description,
        inputSchema: zodToJsonSchema(def.inputSchema),
        annotations: def.annotations,
      }));
    },
  };

  return {
    type: 'sdk',
    name,
    description,
    instructions,
    instance,
  };
}
