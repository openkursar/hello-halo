import type { Goal,GoalChangeSource } from "../../types/goal.js";
import type { ContentBlock,Message,StreamEvent,UsageInfo } from "../../types/provider.js";
import type { FileReadState,ToolServices } from "../../types/tool.js";
import type { ModelUsageEntry } from "./cost.js";
export type SDKMessage = {
    type: 'system';
    subtype: 'init';
    session_id: string;
    tools: string[];
    model: string;
    cwd: string;
    permissionMode: string;
    mcp_servers: Array<{
        name: string;
        status: string;
    }>;
    slash_commands: string[];
    skills: string[];
    apiKeySource: string;
    sdk_version: string;
    betas?: string[];
    uuid: string;
} | {
    type: 'assistant';
    message: {
        toolContext?: import("./tool-context/index.js").ToolContextRecord;
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
} | {
    type: 'user';
    isReplay?: boolean;
    message: {
        role: 'user';
        content: ContentBlock[];
        toolContext?: import("./tool-context/index.js").ToolContextRecord;
    };
    parent_tool_use_id: string | null;
    uuid: string;
    session_id: string;
} | {
    type: 'stream_event';
    event: StreamEvent;
    parent_tool_use_id: string | null;
    uuid: string;
    session_id: string;
} | {
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
    permission_denials: Array<{
        tool_name: string;
        tool_use_id: string;
        tool_input: Record<string, unknown>;
    }>;
    deferred_tool_use?: SDKDeferredToolUse;
    uuid: string;
} | {
    type: 'result';
    subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd';
    errors: string[];
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
    permission_denials: Array<{
        tool_name: string;
        tool_use_id: string;
        tool_input: Record<string, unknown>;
    }>;
    uuid: string;
} | {
    type: 'tool_progress';
    tool_name: string;
    tool_use_id: string;
    parent_tool_use_id: string | null;
    elapsed_time_seconds?: number;
    task_id?: string;
    uuid: string;
    session_id: string;
} | {
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
} | {
    type: 'system';
    subtype: 'api_retry';
    attempt: number;
    max_retries: number;
    retry_delay_ms: number;
    error_status: number | null;
    error: AssistantMessageError | 'unknown';
    error_message?: string;
    session_id: string;
    uuid: string;
} | {
    type: 'system';
    subtype: 'model_fallback';
    from_model: string;
    to_model: string;
    reason: string;
    error_status: number | null;
    session_id: string;
    uuid: string;
} | {
    type: 'system';
    subtype: 'session_state_changed';
    state: 'idle' | 'running' | 'requires_action';
    session_id: string;
    uuid: string;
} | {
    type: 'system';
    subtype: 'hook_started';
    hook_id: string;
    hook_name: string;
    hook_event: string;
    uuid: string;
    session_id: string;
} | {
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
} | {
    type: 'system';
    subtype: 'local_command_output';
    content: string;
    uuid: string;
    session_id: string;
} | {
    type: 'system';
    subtype: 'max_turns_reached';
    max_turns: number;
    turn_count: number;
    session_id: string;
    uuid: string;
} | {
    type: 'system';
    subtype: 'goal_updated';
    goal: Goal | null;
    source: GoalChangeSource;
    session_id: string;
    uuid: string;
};
export type AssistantMessageError = 'authentication_failed' | 'billing_error' | 'rate_limit' | 'invalid_request' | 'server_error' | 'unknown' | 'max_output_tokens';
export interface SDKDeferredToolUse {
    tool_use_id: string;
    tool_name: string;
    tool_input: Record<string, unknown>;
}
export type SDKSystemMessage = Extract<SDKMessage, {
    subtype: 'init';
}>;
export type SDKAssistantMessage = Extract<SDKMessage, {
    type: 'assistant';
}>;
export type SDKUserMessage = Extract<SDKMessage, {
    type: 'user';
}>;
export type SDKPartialAssistantMessage = Extract<SDKMessage, {
    type: 'stream_event';
}>;
export type SDKResultSuccess = Extract<SDKMessage, {
    type: 'result';
    is_error: false;
}>;
export type SDKResultError = Extract<SDKMessage, {
    type: 'result';
    is_error: true;
}>;
export type SDKResultMessage = SDKResultSuccess | SDKResultError;
export type SDKToolProgressMessage = Extract<SDKMessage, {
    type: 'tool_progress';
}>;
export type SDKCompactBoundaryMessage = Extract<SDKMessage, {
    subtype: 'compact_boundary';
}>;
export type SDKAPIRetryMessage = Extract<SDKMessage, {
    subtype: 'api_retry';
}>;
export type SDKModelFallbackMessage = Extract<SDKMessage, {
    subtype: 'model_fallback';
}>;
export type SDKSessionStateChangedMessage = Extract<SDKMessage, {
    subtype: 'session_state_changed';
}>;
export type SDKHookStartedMessage = Extract<SDKMessage, {
    subtype: 'hook_started';
}>;
export type SDKHookResponseMessage = Extract<SDKMessage, {
    subtype: 'hook_response';
}>;
export type SDKLocalCommandOutputMessage = Extract<SDKMessage, {
    subtype: 'local_command_output';
}>;
export type SDKMaxTurnsReachedMessage = Extract<SDKMessage, {
    subtype: 'max_turns_reached';
}>;
export type SDKGoalUpdatedMessage = Extract<SDKMessage, {
    subtype: 'goal_updated';
}>;
export interface MutableConfigOverrides {
    model?: string;
    permissionMode?: string;
    maxThinkingTokens?: number | null;
}
export interface QueryLoopOptions {
    onUsage?: (usage: ModelUsageEntry, model: string) => void;
    getBudgetSpent?: () => number;
    getPendingUsage?: () => Record<string, ModelUsageEntry>;
    toolContext?: import("./tool-context/index.js").ToolDiscoveryState | null;
    onContextMessage?: (message: Message) => void | Promise<void>;
    getToolState?: () => import("../../types/tool.js").Tool[] | undefined;
    onToolContextChange?: (state: import("./tool-context/index.js").ToolDiscoveryState) => void;
    contextState?: {
        budget: import("./token-budget.js").TokenBudget;
        model?: string;
        provider?: import("../../types/provider.js").LlmProvider;
        compactedHistoryTokens?: number;
        deferredCompactionTokens?: number;
    };
    skillCatalog?: import("../skills/index.js").SkillCatalog;
    onProgress?: (msg: SDKMessage) => void;
    onAssistantBlock?: (message: SDKAssistantMessage, responseUuid: string) => void | Promise<void>;
    onAssistantMessage?: (message: SDKAssistantMessage) => void | Promise<void>;
    onToolResultMessage?: (message: SDKUserMessage) => void | Promise<void>;
    onCompact?: (messages: readonly Message[], summary: string) => void | Promise<void>;
    onHistoryCompacted?: (messages: readonly Message[]) => void;
    completedTurns?: number;
    sessionId?: string;
    transcriptPath?: string;
    mcpServerStatuses?: Array<{
        name: string;
        status: string;
        error?: string;
    }>;
    slashCommands?: string[];
    skills?: string[];
    configOverrides?: MutableConfigOverrides;
    getPendingTodos?: () => Array<{
        content: string;
        status: string;
    }>;
    getGoal?: () => Goal | null;
    drainGoalChange?: () => {
        previous: Goal | null;
        current: Goal | null;
    } | null;
    getTodoAttachment?: () => Message | null;
    getPendingNotices?: () => string[];
    getPendingUserMessage?: () => Promise<Message | null>;
    recordFileChange?: (path: string, beforeContent: Buffer, afterContent: Buffer) => void;
    toolServices?: ToolServices;
    readFileState?: Map<string, FileReadState>;
}
