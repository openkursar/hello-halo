/**
 * @module core/query-types
 * Types for the query loop — events yielded by queryLoop() and its options.
 * @license MIT
 */

import type { ContentBlock, Message, StreamEvent, UsageInfo } from '../types/provider.js';
import type { ModelUsageEntry } from './cost.js';
import type { ToolServices, FileReadState } from '../types/tool.js';
import type { Goal, GoalChangeSource } from '../types/goal.js';

// ---------------------------------------------------------------------------
// SDKMessage — events yielded by the query loop
// ---------------------------------------------------------------------------

/**
 * SDKMessage — events yielded by the query loop.
 *
 * Field naming uses snake_case convention for wire-level
 * compatibility with consumer code (host applications, backends, etc.).
 */
export type SDKMessage =
  // System init
  | {
      type: 'system';
      subtype: 'init';
      session_id: string;
      tools: string[];
      model: string;
      cwd: string;
      permissionMode: string;
      mcp_servers: Array<{ name: string; status: string }>;
      slash_commands: string[];
      skills: string[];
      apiKeySource: string;
      sdk_version: string;
      betas?: string[];
      uuid: string;
    }
  // Completed assistant block
  | {
      type: 'assistant';
      message: {
        toolContext?: import('./tool-context/index.js').ToolContextRecord;
        id: string;
        type: 'message';
        role: 'assistant';
        model: string;
        content: ContentBlock[];
        stop_reason: string | null;
        stop_sequence: string | null;
        usage?: UsageInfo;
      };
      parent_tool_use_id: string | null;
      uuid: string;
      session_id: string;
      usage?: UsageInfo;
      error?: AssistantMessageError;
    }
  // User message (tool results)
  | {
      type: 'user';
      /** An accepted input replay, already recorded by the host. */
      isReplay?: boolean;
      message: { role: 'user'; content: ContentBlock[]; toolContext?: import('./tool-context/index.js').ToolContextRecord };
      parent_tool_use_id: string | null;
      uuid: string;
      session_id: string;
    }
  // Streaming event (partial messages)
  | {
      type: 'stream_event';
      event: StreamEvent;
      parent_tool_use_id: string | null;
      uuid: string;
      session_id: string;
    }
  // Result — success
  | {
      type: 'result';
      subtype: 'success';
      result: string;
      is_error: false;
      num_turns: number;
      total_cost_usd: number;
      usage: UsageInfo;
      modelUsage: Record<string, ModelUsageEntry>;
      session_id: string;
      stop_reason: string | null;
      duration_ms: number;
      duration_api_ms: number;
      permission_denials: Array<{ tool_name: string; tool_use_id: string; tool_input: Record<string, unknown> }>;
      deferred_tool_use?: SDKDeferredToolUse;
      uuid: string;
    }
  // Result — error
  | {
      type: 'result';
      subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd';
      /** Error details as individual messages. */
      errors: string[];
      /** Joined error text for consumer compat (consumer reads `message.result`). */
      result: string;
      is_error: true;
      num_turns: number;
      total_cost_usd: number;
      usage: UsageInfo;
      modelUsage: Record<string, ModelUsageEntry>;
      session_id: string;
      stop_reason: string | null;
      duration_ms: number;
      duration_api_ms: number;
      permission_denials: Array<{ tool_name: string; tool_use_id: string; tool_input: Record<string, unknown> }>;
      uuid: string;
    }
  // Tool progress
  | {
      type: 'tool_progress';
      tool_name: string;
      tool_use_id: string;
      parent_tool_use_id: string | null;
      elapsed_time_seconds?: number;
      task_id?: string;
      uuid: string;
      session_id: string;
    }
  // System — compact boundary
  | {
      type: 'system';
      subtype: 'compact_boundary';
      summary: string;
      compact_metadata: {
        trigger: 'auto' | 'manual';
        pre_tokens: number;
        preserved_segment?: string;
      };
      session_id: string;
      uuid: string;
    }
  // System — api_retry
  | {
      type: 'system';
      subtype: 'api_retry';
      attempt: number;
      max_retries: number;
      retry_delay_ms: number;
      error_status: number | null;
      error: AssistantMessageError | 'unknown';
      /** Why the attempt failed, in the server's own words when it gave any. */
      error_message?: string;
      session_id: string;
      uuid: string;
    }
  // System — model_fallback (primary model abandoned for the fallback model)
  | {
      type: 'system';
      subtype: 'model_fallback';
      from_model: string;
      to_model: string;
      reason: string;
      error_status: number | null;
      session_id: string;
      uuid: string;
    }
  // System — session state changed (idle/running/requires_action)
  | {
      type: 'system';
      subtype: 'session_state_changed';
      state: 'idle' | 'running' | 'requires_action';
      session_id: string;
      uuid: string;
    }
  // Hook started
  | {
      type: 'system';
      subtype: 'hook_started';
      hook_id: string;
      hook_name: string;
      hook_event: string;
      uuid: string;
      session_id: string;
    }
  // Hook response
  | {
      type: 'system';
      subtype: 'hook_response';
      hook_id: string;
      hook_name: string;
      hook_event: string;
      output: string;
      stdout: string;
      stderr: string;
      exit_code?: number;
      outcome: 'success' | 'error' | 'cancelled';
      uuid: string;
      session_id: string;
    }
  // Local command output
  | {
      type: 'system';
      subtype: 'local_command_output';
      content: string;
      uuid: string;
      session_id: string;
    }
  // System — max turns reached (emitted immediately before the error result)
  | {
      type: 'system';
      subtype: 'max_turns_reached';
      max_turns: number;
      turn_count: number;
      session_id: string;
      uuid: string;
    }
  // System — the session goal changed (null when it was removed)
  | {
      type: 'system';
      subtype: 'goal_updated';
      goal: Goal | null;
      source: GoalChangeSource;
      session_id: string;
      uuid: string;
    };

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export type AssistantMessageError =
  | 'authentication_failed'
  | 'billing_error'
  | 'rate_limit'
  | 'invalid_request'
  | 'server_error'
  | 'unknown'
  | 'max_output_tokens';

// ---------------------------------------------------------------------------
// Per-kind narrowing types
// ---------------------------------------------------------------------------
// Derived from the union above, so a narrow type cannot describe a shape the
// loop does not yield.

/** Tool call the model deferred to a later turn. */
export interface SDKDeferredToolUse {
  tool_use_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export type SDKSystemMessage = Extract<SDKMessage, { subtype: 'init' }>;
export type SDKAssistantMessage = Extract<SDKMessage, { type: 'assistant' }>;
export type SDKUserMessage = Extract<SDKMessage, { type: 'user' }>;
export type SDKPartialAssistantMessage = Extract<SDKMessage, { type: 'stream_event' }>;
export type SDKResultSuccess = Extract<SDKMessage, { type: 'result'; is_error: false }>;
export type SDKResultError = Extract<SDKMessage, { type: 'result'; is_error: true }>;
export type SDKResultMessage = SDKResultSuccess | SDKResultError;
export type SDKToolProgressMessage = Extract<SDKMessage, { type: 'tool_progress' }>;
export type SDKCompactBoundaryMessage = Extract<SDKMessage, { subtype: 'compact_boundary' }>;
export type SDKAPIRetryMessage = Extract<SDKMessage, { subtype: 'api_retry' }>;
export type SDKModelFallbackMessage = Extract<SDKMessage, { subtype: 'model_fallback' }>;
export type SDKSessionStateChangedMessage = Extract<SDKMessage, { subtype: 'session_state_changed' }>;
export type SDKHookStartedMessage = Extract<SDKMessage, { subtype: 'hook_started' }>;
export type SDKHookResponseMessage = Extract<SDKMessage, { subtype: 'hook_response' }>;
export type SDKLocalCommandOutputMessage = Extract<SDKMessage, { subtype: 'local_command_output' }>;
export type SDKMaxTurnsReachedMessage = Extract<SDKMessage, { subtype: 'max_turns_reached' }>;
export type SDKGoalUpdatedMessage = Extract<SDKMessage, { subtype: 'goal_updated' }>;

// ---------------------------------------------------------------------------
// Query loop options
// ---------------------------------------------------------------------------

/**
 * Mutable config overrides — written by Query control methods (setModel,
 * setPermissionMode, setMaxThinkingTokens) and read by the query loop at
 * the start of each turn so that changes take effect mid-conversation.
 */
export interface MutableConfigOverrides {
  model?: string;
  permissionMode?: string;
  maxThinkingTokens?: number | null;
}

export interface QueryLoopOptions {
  /** Actual returned usage, including summaries; delegated receipts are already charged. */
  onUsage?: (usage: ModelUsageEntry, model: string) => void;
  getBudgetSpent?: () => number;
  getPendingUsage?: () => Record<string, ModelUsageEntry>;
  /** Session-owned discovery state. Null explicitly retains legacy full declarations. */
  toolContext?: import('./tool-context/index.js').ToolDiscoveryState | null;
  /** Persist internal context attachments before the next provider request. */
  onContextMessage?: (message: Message) => void | Promise<void>;
  /** Cheap revision check; returns a fresh filtered pool only when its catalog changed. */
  getToolState?: () => import('../types/tool.js').Tool[] | undefined;
  onToolContextChange?: (state: import('./tool-context/index.js').ToolDiscoveryState) => void;
  /** Session-owned capacity calibration and summary deferral; never shared across providers or sessions. */
  contextState?: {
    budget: import('./token-budget.js').TokenBudget;
    model?: string;
    provider?: import('../types/provider.js').LlmProvider;
    compactedHistoryTokens?: number;
    deferredCompactionTokens?: number;
  };
  /** Advertised skill sources; the loop shares this snapshot with tool contexts. */
  skillCatalog?: import('../skills/index.js').SkillCatalog;
  onProgress?: (msg: SDKMessage) => void;
  /** Persist complete blocks before execution. responseUuid identifies this local response attempt. */
  onAssistantBlock?: (message: SDKAssistantMessage, responseUuid: string) => void | Promise<void>;
  /** Finalize a response, including completed blocks retained after an interrupted tool stream. */
  onAssistantMessage?: (message: SDKAssistantMessage) => void | Promise<void>;
  /** Retain tool results independently of event consumption, including consumer cancellation. */
  onToolResultMessage?: (message: SDKUserMessage) => void | Promise<void>;
  /**
   * Persist a durable compact checkpoint before installing reduced model history or
   * emitting compact_boundary. Awaited; rejection leaves the old live history intact.
   * onHistoryCompacted runs synchronously only after this callback succeeds.
   */
  onCompact?: (messages: readonly Message[], summary: string) => void | Promise<void>;
  /** Replace the owner's retained history when the loop rewrites it (compaction, removed reasoning, relabeled images). */
  onHistoryCompacted?: (messages: readonly Message[]) => void;
  /** Model turns already consumed by automatic continuations of this source request. */
  completedTurns?: number;
  sessionId?: string;
  /** The execution owner's actual journal location. */
  transcriptPath?: string;
  /** MCP server connection statuses (for init message). */
  mcpServerStatuses?: Array<{ name: string; status: string; error?: string }>;
  /** Slash command names available in this session (for init message). */
  slashCommands?: string[];
  /** Skill names available in this session (for init message). */
  skills?: string[];
  /** Shared mutable overrides written by Query control methods. */
  configOverrides?: MutableConfigOverrides;
  /**
   * Current todo items, consulted by the open-work check at the natural end
   * of a turn and by goal recitation. Wired by the composition layer — core
   * must not import tool state directly.
   */
  getPendingTodos?: () => Array<{ content: string; status: string }>;
  /**
   * The session goal (active or finished), or null. Wired by the composition
   * layer; without it the loop runs no goal logic.
   */
  getGoal?: () => Goal | null;
  /**
   * Take the goal change the host made on the user's behalf since the model
   * last saw the goal, if any. Drained at the start of each loop turn.
   */
  drainGoalChange?: () => { previous: Goal | null; current: Goal | null } | null;
  /**
   * Current todo list rendered as a system-reminder attachment, re-injected
   * after full compaction so working memory survives the summary. Returns
   * null when no active todos exist. Wired by the composition layer — core
   * must not import tool state directly.
   */
  getTodoAttachment?: () => Message | null;
  /**
   * Queued out-of-band notices (e.g. background shell task completions) to inject
   * into the conversation. Drained (removed) on read, at the start of each
   * loop turn; multiple notices are joined into a single isMeta message by
   * the drain site. Wired by the composition layer.
   */
  getPendingNotices?: () => string[];
  /** Drain accepted user input before a model step and before finishing the turn. */
  getPendingUserMessage?: () => Promise<Message | null>;
  /**
   * Record a file's before/after content whenever a tool writes to disk, so
   * the host can offer undo/rewind. Wired by the composition layer — core does
   * not own an edit history.
   */
  recordFileChange?: (path: string, beforeContent: Buffer, afterContent: Buffer) => void;
  /**
   * Session-owned services supplied to each tool invocation.
   */
  toolServices?: ToolServices;
  /**
   * Read-before-write state shared across every `send()` of one session.
   * Supplied by the session layer so Write/Edit still honour reads performed
   * in earlier user turns. Absent: the loop keeps the state for its own run.
   */
  readFileState?: Map<string, FileReadState>;
}
