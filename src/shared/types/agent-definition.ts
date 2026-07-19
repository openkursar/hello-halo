/**
 * Agent Definition Types
 *
 * Defines the AgentDefinition type for custom subagent configurations.
 * Originally from claude-code-core SDK types, copied here to eliminate
 * the external dependency on halo-local/claude-code-core.
 */

/**
 * MCP server specification for an agent — either a server name (string)
 * or a record mapping names to transport configs.
 */
export type AgentMcpServerSpec = string | Record<string, McpServerConfigForProcessTransport>

/**
 * Permission mode controlling how tool executions are handled.
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk'

/**
 * Minimal MCP server transport config types used by AgentDefinition.
 * Only the union discriminator is needed here — the full configs are
 * defined in the SDK.
 */
export type McpServerConfigForProcessTransport = {
  type: 'stdio' | 'sse' | 'http' | 'sdk'
  [key: string]: unknown
}

/**
 * Definition for a custom subagent that can be invoked via the Agent tool.
 */
export type AgentDefinition = {
  /** Natural language description of when to use this agent */
  description: string
  /** Array of allowed tool names. If omitted, inherits all tools from parent */
  tools?: string[]
  /** Array of tool names to explicitly disallow for this agent */
  disallowedTools?: string[]
  /** The agent's system prompt */
  prompt: string
  /** Model alias (e.g. 'sonnet', 'opus', 'haiku') or full model ID. If omitted, uses the main model */
  model?: string
  mcpServers?: AgentMcpServerSpec[]
  /** Experimental: Critical reminder added to system prompt */
  criticalSystemReminder_EXPERIMENTAL?: string
  /** Array of skill names to preload into the agent context */
  skills?: string[]
  /** Auto-submitted as the first user turn when this agent is the main thread agent */
  initialPrompt?: string
  /** Maximum number of agentic turns before stopping */
  maxTurns?: number
  /** Run this agent as a background task when invoked */
  background?: boolean
  /** Scope for auto-loading agent memory files */
  memory?: 'user' | 'project' | 'local'
  /** Reasoning effort level for this agent */
  effort?: ('low' | 'medium' | 'high' | 'max') | number
  /** Permission mode controlling how tool executions are handled */
  permissionMode?: PermissionMode
}
