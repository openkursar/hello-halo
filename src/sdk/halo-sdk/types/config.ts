/**
 * @module types/config
 * Options and QueryConfig — the configuration surface area of the SDK.
 * @license MIT
 */

import type { LlmProvider } from './provider.js';
import type { Tool } from './tool.js';
import type { AgentConventions } from '../core/conventions.js';
import type { ModelPricingTable } from '../core/cost.js';
import type { ToolCallingMode } from '../llm/tool-calling/types.js';
import type { GoalInput, TurnEndChecks } from './goal.js';
import type { CodeSearchOptions } from '../search/index.js';

export type PromptProfileId = 'default' | 'explicit';

/** Serializable wording preferences; mappings use the complete model ID sent to the provider. */
export type PromptProfileSelection = PromptProfileId | {
  default?: PromptProfileId;
  models?: Readonly<Record<string, PromptProfileId>>;
};

// ---------------------------------------------------------------------------
// PermissionMode
// ---------------------------------------------------------------------------

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto';

// ---------------------------------------------------------------------------
// CanUseTool callback
// ---------------------------------------------------------------------------

/** Host labels for a single approval, a reusable approval (including reuse), or a refusal. */
export type PermissionDecisionClassification =
  | 'user_temporary'
  | 'user_permanent'
  | 'user_reject';

/**
 * A suggested permission update that can be returned as part of a PermissionResult
 * to persistently change permission rules so the user is not prompted again.
 */
export type PermissionBehavior = 'allow' | 'deny' | 'ask';

export type PermissionUpdateDestination =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'session'
  | 'cliArg';

export type PermissionRuleValue = {
  toolName: string;
  ruleContent?: string;
};

export type PermissionUpdate =
  | { type: 'addRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: 'replaceRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: 'removeRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: 'setMode'; mode: PermissionMode; destination: PermissionUpdateDestination }
  | { type: 'addDirectories'; directories: string[]; destination: PermissionUpdateDestination }
  | { type: 'removeDirectories'; directories: string[]; destination: PermissionUpdateDestination };

/** Decides whether a tool call may run. */
export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    /** Aborts when the request is cancelled. */
    signal: AbortSignal;
    /** Rule updates that would stop the same prompt from appearing again. */
    suggestions?: PermissionUpdate[];
    /** Path that caused the request, when there is one. */
    blockedPath?: string;
    /** Why approval is being asked. */
    decisionReason?: string;
    /** Complete prompt text supplied by the bridge. */
    title?: string;
    /** Brief label for the action, such as "Read file". */
    displayName?: string;
    /** Secondary text supplied by the bridge. */
    description?: string;
    /** Identifier of the tool call being approved. */
    toolUseID: string;
    /** Retained for Claude Agent SDK compatibility; this runtime does not set it. */
    agentID?: string;
  },
) => Promise<PermissionResult>;

export type PermissionResult =
  | {
      behavior: 'allow';
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[];
      toolUseID?: string;
      decisionClassification?: PermissionDecisionClassification;
    }
  | {
      behavior: 'deny';
      message?: string;
      interrupt?: boolean;
      toolUseID?: string;
      decisionClassification?: PermissionDecisionClassification;
    };

// ---------------------------------------------------------------------------
// HookEvent system (simplified — SDK preserves callback interface)
// ---------------------------------------------------------------------------

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'PreCompact'
  | 'PostCompact';

// ---------------------------------------------------------------------------
// Hook input types — typed union
// ---------------------------------------------------------------------------

export type BaseHookInput = {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
};

export type PreToolUseHookInput = BaseHookInput & {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
};

export type PostToolUseHookInput = BaseHookInput & {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
  tool_response: unknown;
};

export type PostToolUseFailureHookInput = BaseHookInput & {
  hook_event_name: 'PostToolUseFailure';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
  error: string;
};

export type UserPromptSubmitHookInput = BaseHookInput & {
  hook_event_name: 'UserPromptSubmit';
  prompt: string;
};

export type SessionStartHookInput = BaseHookInput & {
  hook_event_name: 'SessionStart';
  source: 'startup' | 'resume';
};

export type SessionEndHookInput = BaseHookInput & {
  hook_event_name: 'SessionEnd';
  /** In-process sessions always report `other` — there is no CLI exit path. */
  reason: 'other';
};

export type StopHookInput = BaseHookInput & {
  hook_event_name: 'Stop';
  stop_hook_active: boolean;
};

export type PreCompactHookInput = BaseHookInput & {
  hook_event_name: 'PreCompact';
  trigger: 'auto';
  custom_instructions: string | null;
};

export type PostCompactHookInput = BaseHookInput & {
  hook_event_name: 'PostCompact';
  trigger: 'auto';
  compact_summary: string;
};

/**
 * Typed union of all hook input variants.
 */
export type HookInput =
  | PreToolUseHookInput
  | PostToolUseHookInput
  | PostToolUseFailureHookInput
  | UserPromptSubmitHookInput
  | SessionStartHookInput
  | SessionEndHookInput
  | StopHookInput
  | PreCompactHookInput
  | PostCompactHookInput;

/**
 * Hook output — the keys the hook engine reads back. Every key below has an
 * effect on a live hook event; keys not listed here are ignored.
 */
export type HookJSONOutput = {
  /** PreToolUse: permission decision. Other events ignore it. */
  permissionDecision?: 'allow' | 'deny';
  /** PreToolUse: reason recorded alongside the decision. */
  permissionDecisionReason?: string;
  /** PreToolUse: replacement tool input for this and later hooks. */
  updatedInput?: Record<string, unknown>;
  /** PreToolUse / PostToolUse / UserPromptSubmit: context added to the conversation. */
  additionalContext?: string;
  /** PostToolUse: replacement result for an MCP tool. */
  updatedMCPToolOutput?: unknown;
  /** Stop: a message the loop treats as a blocking error. */
  blockingError?: string;
  /** Stop: `block` blocks continuation. */
  decision?: 'block';
  /** Stop: reason the continuation is blocked. */
  reason?: string;
  /** Stop: fallback text when `reason` is absent. */
  systemMessage?: string;
  /** Stop: ends the turn loop outright, winning over any blocking error. */
  preventContinuation?: boolean;
};

/**
 * Hook callback function — typed input parameter for hook events.
 */
export type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<HookJSONOutput>;

export interface HookCallbackMatcher {
  matcher?: string;
  hooks: HookCallback[];
  timeout?: number;
}

// ---------------------------------------------------------------------------
// MCP Server Config
// ---------------------------------------------------------------------------

export type McpStdioServerConfig = {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type McpSSEServerConfig = {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
};

export type McpHttpServerConfig = {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
};

export type McpSdkServerConfig = {
  type: 'sdk';
  name: string;
  description?: string;
  instructions?: string;
};

export type McpServerConfig =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig
  | McpSdkServerConfig
  | McpSdkServerConfigWithInstance;

/**
 * SDK server config with a live instance (not serializable).
 * Created by `createSdkMcpServer()`.
 */
export type McpSdkServerConfigWithInstance = McpSdkServerConfig & {
  instance: import('../tools/mcp/sdk-server.js').SdkMcpServerInstance;
};

/** Runtime status of an MCP server connection. */
export interface McpServerStatus {
  /** Server name as configured. */
  name: string;
  /** Current connection status. */
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  /** Reported by the server once connected. */
  serverInfo?: { name: string; version: string };
  /** Failure reason when status is 'failed'. */
  error?: string;
  /** Configuration scope (e.g., 'project', 'user', 'local'). */
  scope?: string;
  /** Tools the server exposes; filled in after connecting. */
  tools?: Array<{
    name: string;
    description?: string;
    annotations?: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean };
  }>;
}

/** Outcome of a setMcpServers() call. */
export interface McpSetServersResult {
  /** Servers newly added. */
  added: string[];
  /** Servers dropped. */
  removed: string[];
  /** Connection error per server name, for servers that could not connect. */
  errors: Record<string, string>;
}

// ---------------------------------------------------------------------------
// SdkBeta
// ---------------------------------------------------------------------------

export type SdkBeta = 'context-1m-2025-08-07' | string;

// ---------------------------------------------------------------------------
// SettingSource
// ---------------------------------------------------------------------------

export type SettingSource = 'user' | 'project' | 'local';

// ---------------------------------------------------------------------------
// ModelInfo
// ---------------------------------------------------------------------------

export interface ModelInfo {
  value: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: Array<'low' | 'medium' | 'high' | 'max'>;
  supportsAdaptiveThinking?: boolean;
}

// ---------------------------------------------------------------------------
// SlashCommand
// ---------------------------------------------------------------------------

export interface SlashCommand {
  name: string;
  description: string;
  /** Hint text for the argument (e.g., "<file_path>"). */
  argumentHint?: string;
}

// ---------------------------------------------------------------------------
// ThinkingConfig
// ---------------------------------------------------------------------------

export type ThinkingConfig =
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'adaptive' }
  | { type: 'disabled' };

// ---------------------------------------------------------------------------
// EffortLevel
// ---------------------------------------------------------------------------

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

// ---------------------------------------------------------------------------
// Options — the primary configuration for query()
// ---------------------------------------------------------------------------

/**
 * Options for a query or session.
 */
export type ToolLoadingMode = 'eager' | 'deferred';

/** Host-owned presentation policy; it never grants a tool that the session cannot execute. */
export interface ToolDiscoveryOptions {
  services: Record<string, {
    identity: string;
    loading: ToolLoadingMode;
    summary?: string;
    usageGuide?: string;
    toolOverrides?: Record<string, ToolLoadingMode>;
  }>;
}

export interface Options {
  /** Local collaboration is lazy. Application hosts supply their own scoped tools. */
  collaboration?: false | { mode: 'hosted' } | ({ mode: 'local' } & import('../collaboration/sdk/index.js').LocalCollaborationOptions);
  /** Optional client-side MCP discovery. Omitted options retain full tool declarations. */
  toolDiscovery?: ToolDiscoveryOptions;
  /** Authoritative skill sources. Empty disables all skills; omitted preserves discovery. Bodies are read on invocation. */
  skillCatalog?: import('../skills/index.js').SkillCatalog;
  /** Cancels the running query when aborted. */
  abortController?: AbortController;
  /** Additional directories the agent can access beyond cwd */
  additionalDirectories?: string[];
  /**
   * Context window of the target endpoint, in tokens. Drives compaction,
   * tool-result reduction, and usage reporting.
   *
   * Declare it whenever the endpoint is not a 200k-token model — the SDK does
   * not infer the window from the model name, so an undeclared 32k model will
   * overflow and an undeclared 1M model will be compacted far too early.
   */
  contextWindow?: number;
  /**
   * Permission bypass list — tools listed here skip the `canUseTool` callback
   * and execute without prompting the user.
   *
   * This is a **permission** concept, not a tool pool filter.
   * It does NOT control which tools are visible to the model —
   * use `tools` to restrict the available tool set.
   *
   * Supports exact name (`"Bash"`) or pattern with args (`"Bash(git:*)"`).
   */
  allowedTools?: string[];
  /** Custom permission handler */
  canUseTool?: CanUseTool;
  /** Resume the latest conversation. */
  continue?: boolean;
  /** Current working directory */
  cwd?: string;
  /**
   * Blacklist — tool names removed from the model's visible tool pool entirely.
   * Applied after `tools` base set selection. Affects both built-in and MCP tools.
   *
   * Different from `allowedTools`, which is a permission bypass and does not
   * affect the tool pool.
   *
   * A `Read(<path>)` entry removes no tool: it closes that path to Read, Glob
   * and Grep, in the `Read(<path>)` rule syntax (see utils/read-deny).
   */
  disallowedTools?: string[];
  /**
   * Base built-in tool set available to the model.
   *
   * - `undefined` (default) — all built-in tools are available
   * - `string[]` — only the listed built-in tools are available
   * - `[]` — no built-in tools (MCP tools are still added separately)
   *
   * MCP tools (`mcp__*`) are always included regardless of this setting.
   * To remove specific tools, use `disallowedTools`.
   * To bypass permission prompts without changing the tool pool, use `allowedTools`.
   */
  tools?: string[] | { type: 'preset'; preset: 'default' };
  /** Environment variables */
  env?: Record<string, string | undefined>;
  /**
   * Override where the engine looks for instructions, skills and per-user
   * state. Merged over {@link DEFAULT_CONVENTIONS}; supplying an array
   * replaces it wholesale.
   */
  conventions?: Partial<AgentConventions>;
  /** Fallback model */
  fallbackModel?: string;
  /** Fork session on resume */
  forkSession?: boolean;
  /** Beta features */
  betas?: SdkBeta[];
  /** Hook callbacks */
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /** Session persistence */
  persistSession?: boolean;
  /** Include streaming events in output */
  includePartialMessages?: boolean;
  /** Thinking configuration */
  thinking?: ThinkingConfig;
  /**
   * The model takes adaptive thinking (no token budget). When true, a
   * `maxThinkingTokens` budget turns thinking on in adaptive mode instead of
   * sending the budget.
   */
  adaptiveThinking?: boolean;
  /** Work-response ceiling, reduced to available context and explicit provider limits per request. Internal summaries use a separate allowance. Defaults to 16384. */
  maxOutputTokens?: number;
  /** Effort level */
  effort?: EffortLevel;
  /** @deprecated Use `thinking` instead */
  maxThinkingTokens?: number;
  /** Maximum conversation turns */
  maxTurns?: number;
  /** Maximum budget in USD */
  maxBudgetUsd?: number;
  /**
   * Per-model pricing keyed by model id. Models not listed are costed at
   * zero, so `total_cost_usd` and `maxBudgetUsd` only account for them.
   */
  modelPricing?: ModelPricingTable;
  /** Token budget forwarded to the API as output_config.task_budget. */
  taskBudget?: { total: number };
  /** MCP server configurations */
  mcpServers?: Record<string, McpServerConfig>;
  /** Model to use */
  model?: string;
  /** Permission mode */
  permissionMode?: PermissionMode;
  /** Session ID to resume */
  resume?: string;
  /** Custom session ID */
  sessionId?: string;
  /** Resume up to a specific message */
  resumeSessionAt?: string;
  /**
   * With `resume`, refuse to start rather than continue from stored history
   * that is missing, unreadable or would lose recorded content: creation
   * rejects with an error whose `code` is `RESUME_HISTORY_UNAVAILABLE`.
   */
  strictResume?: boolean;
  /** Stderr callback */
  stderr?: (data: string) => void;
  /** System prompt configuration */
  systemPrompt?: string | { type: 'preset'; preset: 'default'; append?: string };
  /** Preset wording only. A complete systemPrompt string is never rewritten. */
  promptProfile?: PromptProfileSelection;

  /** Additional settings (path to JSON or inline object). */
  settings?: string | Record<string, unknown>;
  /** Which settings locations are read. */
  settingSources?: SettingSource[];
  /** Enable debug mode. */
  debug?: boolean;
  /** Answers elicitation requests raised by MCP servers. */
  onElicitation?: (
    request: Record<string, unknown>,
    options: { signal: AbortSignal },
  ) => Promise<Record<string, unknown>>;

  // --- Agent SDK extensions (superset) ---

  /**
   * Tool calling protocol for this session.
   *
   * - `'native'` — Use the provider's native function-calling API.
   *                This is the default, independently of the model name.
   * - `'xml'`    — Prompt-injected BFCL-style XML tool calling. The SDK
   *                injects tool descriptions as BFCL XML into the system prompt
   *                and parses `<tool><param name="p">v</param></tool>` output.
   *                Selected only when the caller requests this protocol.
   * - `'json'`   — Prompt-injected JSON code-fence tool calling. The model
   *                outputs ```json [...]``` blocks.
   *
   * When omitted, the SDK uses native tool calling. The caller chooses any
   * prompt-based protocol explicitly; discovery does not change this choice.
   */
  toolCallingMode?: ToolCallingMode;

  /** LLM provider instance (if not set, uses default Anthropic) */
  provider?: LlmProvider;
  /** Custom tool instances to add to the registry */
  customTools?: Tool[];
  /** Optional local code search. Its dedicated cache directory is closed to built-in file readers; startup is lazy. */
  codeSearch?: CodeSearchOptions;
  /** Maximum characters per tool result before truncation */
  toolResultBudget?: number;
  /** Slash commands available in this session (names or full objects). */
  slashCommands?: Array<string | SlashCommand>;
  /** Skill names available in this session. */
  skills?: string[];
  /**
   * Goal to start the session with, as if the user had set it. Ignored when a
   * resumed session already has a goal of its own.
   */
  goal?: GoalInput;
  /**
   * End-of-turn checks run when the model stops on its own.
   * Defaults: `{ openWork: true, completion: false }`.
   */
  turnEndChecks?: TurnEndChecks;

  // --- Convenience aliases ---
  // These fields allow options objects (with apiKey/anthropicBaseUrl
  // at the top level) to be passed directly to the in-process SDK.

  /**
   * Anthropic API key — the in-process SDK reads this
   * and creates a provider automatically. Equivalent to env.ANTHROPIC_API_KEY.
   */
  apiKey?: string;
  /**
   * Anthropic API base URL.
   * Equivalent to env.ANTHROPIC_BASE_URL.
   */
  anthropicBaseUrl?: string;
  /**
   * Optional request identity injected into every Anthropic API request.
   * When provided, custom headers, a system-prompt prefix block, and
   * body-level metadata are included. The SDK ships no provider-specific
   * identity constants — the host application supplies them.
   */
  requestIdentity?: import('../llm/request-identity.js').RequestIdentity;
}

// ---------------------------------------------------------------------------
// QueryConfig — internal resolved configuration
// ---------------------------------------------------------------------------

/** Internal resolved configuration derived from Options. */
export interface QueryConfig {
  toolDiscovery?: ToolDiscoveryOptions;
  skillCatalog?: import('../skills/index.js').SkillCatalog;
  model: string;
  maxTokens: number;
  /** Resolved context window in tokens. Never undefined — see Options.contextWindow. */
  contextWindow: number;
  maxTurns: number;
  maxBudgetUsd: number;
  modelPricing: ModelPricingTable;
  cwd: string;
  env: Record<string, string | undefined>;
  systemPrompt: string | { type: 'preset'; preset: 'default'; append?: string };
  promptProfile?: PromptProfileSelection;
  thinking: ThinkingConfig;
  /** False only when the mode was unspecified and effort may choose it. */
  thinkingExplicit?: boolean;
  adaptiveThinking: boolean;
  effort: EffortLevel;
  toolResultBudget: number;
  includePartialMessages: boolean;
  permissionMode: PermissionMode;
  /** Permission bypass list — skips canUseTool check. Does not filter the tool pool. */
  allowedTools?: string[];
  /** Blacklist — tools removed from the model's visible pool. */
  disallowedTools?: string[];
  /** Canonical paths closed by Read rules and session-owned internal cache protection. Never undefined. */
  readDenyRoots: string[];
  mcpServers?: Record<string, McpServerConfig>;
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  canUseTool?: CanUseTool;
  abortSignal: AbortSignal;
  fallbackModel?: string;
  betas?: SdkBeta[];
  /** Token budget forwarded to the API as output_config.task_budget. */
  taskBudget?: { total: number };
  /** Directories the agent may access beyond cwd. */
  additionalDirectories?: string[];
  /** Which settings sources to load memory files from (preset mode only). */
  settingSources?: SettingSource[];
  /** Resolved filesystem/env conventions. Never undefined. */
  conventions: AgentConventions;
  /**
   * Resolved tool calling mode.
   *
   * Never undefined — always one of 'native', 'xml', or 'json'.
   * Set by resolveQueryConfig() via auto-detection or explicit Options.toolCallingMode.
   */
  toolCallingMode: ToolCallingMode;
  /** Resolved end-of-turn checks. Never undefined. */
  turnEndChecks: Required<TurnEndChecks>;
}

// ---------------------------------------------------------------------------
// AccountInfo — authenticated account metadata
// ---------------------------------------------------------------------------

/** Account of the signed-in user. */
export interface AccountInfo {
  /** Only caller-supplied credentials are accepted, so this is always `user`. */
  apiKeySource: string;
}

// ---------------------------------------------------------------------------
// SDKControlInitializeResponse
// ---------------------------------------------------------------------------

/** Full initialization response from the session. */
export interface SDKControlInitializeResponse {
  commands: SlashCommand[];
  models: ModelInfo[];
  accountInfo: AccountInfo;
  mcpServers: McpServerStatus[];
}

// ---------------------------------------------------------------------------
// SDKPermissionDenial — permission denial record
// ---------------------------------------------------------------------------

/** Record of a denied tool use. */
export interface SDKPermissionDenial {
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
}

