export interface PreToolUseHookResult {
    decision?: 'allow' | 'deny';
    decisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
}
export interface PostToolUseHookResult {
    additionalContext?: string;
    updatedToolOutput?: unknown;
}
