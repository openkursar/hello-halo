import type { Message,ProviderRequest,UsageInfo } from "../../types/provider.js";
export type BudgetRequest = Pick<ProviderRequest, 'messages' | 'systemPrompt' | 'tools'> & Partial<Pick<ProviderRequest, 'model' | 'thinking'>>;
export interface TokenBudget {
    readonly contextWindow: number;
    readonly maxOutputTokens: number;
    configureOutput(thinking: ProviderRequest['thinking'], outputTokenLimit?: number): void;
    readonly outputReservationTokens: number;
    requestMaxTokens(inputTokens: number, ceiling?: number): number;
    readonly availableInputTokens: number;
    readonly targetInputTokens: number;
    estimateRequest(request: BudgetRequest): number;
    observe(request: BudgetRequest, usage: UsageInfo | undefined): void;
    readonly compactionTriggerTokens: number;
    shouldCompactRequest(request: BudgetRequest): boolean;
    reset(): void;
    updateFromUsage(inputTokens: number): void;
    currentInputTokens(messages: Message[]): number;
    remainingInputTokens(messages: Message[]): number;
    usageRatio(messages: Message[]): number;
    shouldCompact(messages: Message[]): boolean;
    summary(messages: Message[]): string;
}
