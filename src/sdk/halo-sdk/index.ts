import type { PermissionMode, SlashCommand, ModelInfo, AccountInfo, McpServerStatus, McpSetServersResult, SDKControlInitializeResponse } from './types/config.js';
import type { SessionRuntimeStats } from './core/session.js';
import type { SDKMessage, SDKUserMessage } from './core/query-types.js';
import type { Goal, GoalInput } from './types/goal.js';
import type { TranscriptOptions } from './core/transcript.js';

export {
  getBuiltinSkillDefinitions,
  createSession,
  queryLoop,
  CostTracker,
  TokenBudget,
  resolveQueryConfig,
  resolvePromptProfile,
  microCompact,
  apiCompact,
  autoCompactIfNeeded,
  fullCompact,
  AutoCompactState,
  formatCompactSummary,
  getCompactPrompt,
  runHooks,
  runPreToolUseHooks,
  runPostToolUseHooks,
  runPostToolUseFailureHooks,
  runEventHooks,
  BUILT_IN_COMMANDS,
  BUILT_IN_COMMAND_NAMES,
  CommandRegistry,
  buildSessionRegistry,
  createSessionRegistry,
  filterUserInvocable,
  getBuiltInCommands,
  getCommandName,
  globalRegistry,
  isCommand,
  isCommandEnabled,
  listUserInvocableNames,
  listUserInvocableSlashCommands,
  normalizeUserCommands,
  resolveCommand,
  toSlashCommand,
  toSlashCommandList,
  PromptToolCallingAdapter,
  resolveToolCallingMode,
  detectModelFamily,
  renderToolsBlock,
  parseXmlToolCalls,
  readSessionToolContextMode,
  query,
  unstable_v2_createSession,
  unstable_v2_prompt,
  unstable_v2_resumeSession,
  toolSuccess,
  toolError,
  toToolDefinition,
  createProvider,
  createWellKnownProvider,
  listWellKnownProviders,
  AnthropicProvider,
  OpenAiCompatProvider,
  parseSSEStream,
  applyModelQuirks,
  applyStreamQuirks,
  isQuirkyModel,
  getAllTools,
  filterTools,
  findToolByName,
  createCodeSearchService,
  getCodeSearchDiagnostics,
  createCodeSearchTool,
  tool,
  createSdkMcpServer,
  bridgeSdkMcpTools,
  extractSdkMcpTools,
  isSdkMcpServerConfig,
  connectExternalMcpServers,
  McpConnectionManager,
  createMcpConnectionManager,
  McpClient,
  StdioTransport,
  SSETransport,
  HttpTransport,
  assembleSystemPrompt,
  splitAtBoundary,
  DEFAULT_MAX_RESULT_SIZE_CHARS,
  PROMPT_CACHE_BOUNDARY,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TOOL_RESULT_BUDGET,
  AUTO_COMPACT_THRESHOLD,
  MAX_INPUT_TOKENS,
  TARGET_INPUT_TOKENS,
  API_COMPACT_THRESHOLD_PCT,
  API_COMPACT_TARGET_PCT,
  KEEP_RECENT_MESSAGES,
  MAX_CONSECUTIVE_COMPACT_FAILURES,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_CONTEXT_WINDOW,
  MAX_TOKENS_RECOVERY_LIMIT,
  UNREADABLE_TOOL_CALL_RETRY_LIMIT,
  MAX_TOKENS_RECOVERY_MSG,
  GOAL_RECITATION_INTERVAL,
  truncateToolResult,
  estimateTokens,
  estimateMessageTokens,
  SDKError,
  ProviderError,
  AbortError,
  ToolExecutionError,
  BudgetExceededError,
  MaxTurnsExceededError,
  CompactError,
  ResumeHistoryError,
  RESUME_HISTORY_UNAVAILABLE,
  isResumeHistoryError,
  setLogger,
  getLogger,
  getRootLogger,
  redactHeaders,
  redactSecrets,
  truncateField,
  listSessions,
  getSessionInfo,
  getSessionMessages,
  getArchivedRecordMessages,
  listArchivedRecords,
  forkSession,
  renameSession,
  tagSession,
  getHarnessTextCatalog,
} from './native/index.js';

export type { BuiltinSkillDefinition, SkillCatalog, SkillEntry, SkillMetadata, SkillSource } from './skills/index.js';
export type { SDKSession, SessionCloseOptions, SessionRuntimeStats } from './core/session.js';
export type { SDKMessage, QueryLoopOptions, MutableConfigOverrides } from './core/query-types.js';
export type { ModelUsageEntry, ModelPricing, ModelPricingTable } from './core/cost.js';
export type { PromptProfile } from './prompt/profiles/index.js';
export type { PromptProfileId, PromptProfileSelection } from './types/config.js';
export type {
  PreToolUseHookResult,
  PostToolUseHookResult,
} from './core/hooks.js';
export type {
  Command,
  CommandBase,
  CommandKind,
  CommandSource,
  LocalCommand,
  PromptCommand,
} from './commands/index.js';
export type { ToolCallingMode, ModelFamily, ModelAdapter } from './llm/tool-calling/types.js';
export type { ReadSessionToolContextModeOptions, SessionToolContextMode } from './core/session-tool-context.js';
export type {
  Options,
  ToolDiscoveryOptions,
  ToolLoadingMode,
  QueryConfig,
  PermissionMode,
  PermissionBehavior,
  PermissionDecisionClassification,
  PermissionUpdate,
  PermissionUpdateDestination,
  PermissionRuleValue,
  CanUseTool,
  PermissionResult,
  HookEvent,
  HookCallback,
  HookCallbackMatcher,
  HookInput,
  HookJSONOutput,
  BaseHookInput,
  PreToolUseHookInput,
  PostToolUseHookInput,
  PostToolUseFailureHookInput,
  UserPromptSubmitHookInput,
  SessionStartHookInput,
  SessionEndHookInput,
  StopHookInput,
  PreCompactHookInput,
  PostCompactHookInput,
  McpStdioServerConfig,
  McpSSEServerConfig,
  McpHttpServerConfig,
  McpServerConfig,
  McpServerStatus,
  McpSetServersResult,
  AccountInfo,
  SdkBeta,
  SettingSource,
  ModelInfo,
  SlashCommand,
  ThinkingConfig,
  EffortLevel,
  SDKControlInitializeResponse,
  SDKPermissionDenial,
} from './types/config.js';
export type {
  LlmProvider,
  ProviderRequest,
  ProviderResponse,
  StreamEvent,
  Message,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  UsageInfo,
  SystemPromptBlock,
  ToolDefinition,
} from './types/provider.js';
export type {
  Tool,
  ToolResult,
  ToolContext,
  ShellState,
  PermissionLevel,
} from './types/tool.js';
export type {
  Goal,
  GoalInput,
  GoalStatus,
  GoalChangeSource,
  TurnEndChecks,
} from './types/goal.js';
export type {
  AssistantMessageError,
  SDKAPIRetryMessage,
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKDeferredToolUse,
  SDKHookResponseMessage,
  SDKHookStartedMessage,
  SDKLocalCommandOutputMessage,
  SDKMaxTurnsReachedMessage,
  SDKGoalUpdatedMessage,
  SDKModelFallbackMessage,
  SDKPartialAssistantMessage,
  SDKResultError,
  SDKResultMessage,
  SDKResultSuccess,
  SDKSessionStateChangedMessage,
  SDKSystemMessage,
  SDKToolProgressMessage,
  SDKUserMessage,
  // Note: SDKPermissionDenial is exported from types/config.ts
} from './core/query-types.js';
export type {
  ProviderConfig,
} from './llm/provider.js';
export type {
  AnthropicProviderConfig,
} from './llm/anthropic.js';
export type {
  RequestIdentity,
} from './llm/request-identity.js';
export type {
  OpenAiCompatProviderConfig,
  ProviderQuirks,
} from './llm/openai-compat.js';
export type { CodeSearchOptions, CodeSearchRequest, CodeSearchResult, CodeSearchHit, CodeSearchDiagnostics, CodeSearchService } from './search/index.js';
export type {
  SdkMcpToolDefinition,
  CallToolResult,
  ToolAnnotations as McpToolAnnotations,
  CreateSdkMcpServerOptions,
  McpSdkServerConfig,
  McpSdkServerConfigWithInstance,
  SdkMcpServerInstance,
  AnyZodRawShape,
  InferShape,
} from './tools/mcp/sdk-server.js';
export type { ExternalMcpConnection, McpServerConnectionStatus } from './tools/mcp/bridge.js';
export type { McpServerLiveStatus, CreateMcpConnectionManagerOptions } from './tools/mcp/connection-manager.js';
export type { McpElicitationHandler } from './tools/mcp/client.js';
export type {
  McpServerCapabilities,
  McpServerInfo,
  McpToolDefinition,
  McpCallToolResult,
} from './tools/mcp/client.js';
export type {
  StdioTransportOptions,
  SSETransportOptions,
  HttpTransportOptions,
} from './tools/mcp/transports.js';
export type {
  McpTransport,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  JsonRpcError,
} from './tools/mcp/jsonrpc.js';
export type { SystemPromptConfig } from './prompt/system-prompt.js';
export type { ResumeHistoryReason } from './utils/errors.js';
export type { Logger, LogLevel, LogFields } from './utils/logger.js';
export type { HarnessTextConfiguration, HarnessTextTemplate } from './types/config.js';

/**
 * The Query object — an AsyncGenerator<SDKMessage> with additional
 * control methods for mid-stream interaction.
 *
 * The Query object returned by the `query()` function.
 */
export interface Query extends AsyncGenerator<SDKMessage, void, undefined> {
  /** Execution-owned task counts, without task contents. */
  getRuntimeStats(): Promise<SessionRuntimeStats>;
  /** Interrupt the current query. */
  interrupt(): Promise<void>;
  /** Change the permission mode mid-conversation. */
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /** Change the model mid-conversation. */
  setModel(model?: string): Promise<void>;
  /** Change max thinking tokens mid-conversation. */
  setMaxThinkingTokens(n: number | null): Promise<void>;
  /** Get the full initialization response. */
  initializationResult(): Promise<SDKControlInitializeResponse>;
  /** Get available slash commands. */
  supportedCommands(): Promise<SlashCommand[]>;
  /** Get available models. */
  supportedModels(): Promise<ModelInfo[]>;
  /** Get MCP server connection statuses. */
  mcpServerStatus(): Promise<McpServerStatus[]>;
  /** Get account info for the authenticated user. */
  accountInfo(): Promise<AccountInfo>;
  /** Reconnect a specific MCP server by name. */
  reconnectMcpServer(serverName: string): Promise<void>;
  /** Turn a named MCP server on or off. */
  toggleMcpServer(serverName: string, enabled: boolean): Promise<void>;
  /** Replace the set of dynamic MCP servers. */
  setMcpServers(servers: Record<string, unknown>): Promise<McpSetServersResult>;
  /** Stop a running background task. */
  stopTask(taskId: string): Promise<void>;
  /** The goal of this query (active or finished), or null when none is set. */
  getGoal(): Goal | null;
  /**
   * Replace the goal on the user's behalf, or clear it with null. The model
   * is told at the start of its next turn.
   *
   * @throws TypeError when the objective is missing or blank.
   */
  setGoal(goal: GoalInput | null): Goal | null;
  /** Close the query and stop its background tasks. */
  close(): void;
  /**
   * Rejects additional input: query() is a one-shot API. Use
   * createSession().send() or sendIntoLiveTurn() for subsequent messages.
   */
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
}

/** Session info returned by listSessions / getSessionInfo. */
export interface SDKSessionInfo {
  sessionId: string;
  /** Display title: customTitle ?? firstPrompt ?? sessionId. */
  summary: string;
  /** Last write time, epoch milliseconds. */
  lastModified: number;
  /** File size of the transcript in bytes. */
  fileSize?: number;
  /** User-set custom title (via renameSession). */
  customTitle?: string;
  /** Earliest substantive user prompt. */
  firstPrompt?: string;
  /** Git branch at session creation time. */
  gitBranch?: string;
  /** Working directory. */
  cwd?: string;
  /** User-set tag (via tagSession). */
  tag?: string;
  /** Creation time, epoch milliseconds. */
  createdAt?: number;
}

/** Session message returned by getSessionMessages. */
export interface SessionMessage {
  type: 'user' | 'assistant' | 'system';
  uuid: string;
  session_id: string;
  message: unknown;
  parent_tool_use_id: string | null;
}

/** Options for listing sessions. */
export interface ListSessionsOptions extends TranscriptOptions {
  /** Project directory path. Alias: `dir`. */
  cwd?: string;
  /** Alias for `cwd`. */
  dir?: string;
  limit?: number;
  offset?: number;
  /** Worktree enumeration is unsupported; true rejects instead of silently narrowing results. */
  includeWorktrees?: boolean;
}

/** Options for getting session info. */
export interface GetSessionInfoOptions extends TranscriptOptions {
  cwd?: string;
  /** Alias for `cwd`. */
  dir?: string;
}

/** Options for getting session messages. */
export interface GetSessionMessagesOptions extends TranscriptOptions {
  cwd?: string;
  /** Alias for `cwd`. */
  dir?: string;
  limit?: number;
  offset?: number;
  /** When true, include system messages in the returned list. */
  includeSystemMessages?: boolean;
}

/** Options for reading a historical related transcript. */
export interface GetArchivedRecordMessagesOptions extends TranscriptOptions {
  cwd?: string;
  /** Alias for `cwd`. */
  dir?: string;
  /** Cap on how many messages are returned. */
  limit?: number;
  /** How many leading messages to skip. */
  offset?: number;
}

/** Options for listing historical related transcripts. */
export interface ListArchivedRecordsOptions extends TranscriptOptions {
  cwd?: string;
  /** Alias for `cwd`. */
  dir?: string;
}

/** Options for forking a session into a new one. */
export interface ForkSessionOptions extends SessionMutationOptions {
  /** Fork up to (and including) this message UUID. */
  upToMessageId?: string;
  /** Title for the forked session. */
  title?: string;
}

/** Result of forking a session. */
export interface ForkSessionResult {
  sessionId: string;
}

/** Options for session mutation operations. */
export interface SessionMutationOptions extends TranscriptOptions {
  cwd?: string;
}
