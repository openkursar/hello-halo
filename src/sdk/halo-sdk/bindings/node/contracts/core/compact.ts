import type { PromptProfileSelection } from "../../types/config.js";
import type { LlmProvider,Message,ProviderRequest,ProviderResponse,ThinkingConfig } from "../../types/provider.js";
export type PartialCompactDirection = 'from' | 'up_to';
export interface AutoCompactState {
    compactionCount: number;
    consecutiveFailures: number;
    disabled: boolean;
    onSuccess(): void;
    onFailure(): void;
}
export interface CompactOptions {
    signal?: AbortSignal;
    maxTokens?: number;
    thinking?: ThinkingConfig;
    reasoningEffort?: string;
    promptProfile?: PromptProfileSelection;
    request?: ProviderRequest;
    injectedMessages?: Message[];
    targetInputTokens?: number;
    maxInputTokens?: number;
    estimateInputTokens?: (history: Message[]) => number;
    prepareCandidate?: (messages: Message[]) => Message[];
    onResponse?: (response: ProviderResponse) => void;
}
export interface CompactResult {
    messages: Message[];
    summary: string;
    tokensFreed: number;
}
export interface PartialCompactOptions extends CompactOptions {
    pivotIndex: number;
    direction?: PartialCompactDirection;
    provider: LlmProvider;
    model: string;
    userFeedback?: string;
    attachments?: Message[];
    transcriptPath?: string;
}
