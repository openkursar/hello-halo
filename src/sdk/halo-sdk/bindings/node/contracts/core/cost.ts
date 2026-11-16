import type { UsageInfo } from "../../types/provider.js";
export interface ModelPricing {
    inputPerMtk: number;
    outputPerMtk: number;
    cacheCreationPerMtk: number;
    cacheReadPerMtk: number;
}
export type ModelPricingTable = Record<string, ModelPricing>;
export interface ModelUsageEntry {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    total_cost_usd: number;
    contextWindow: number;
}
export interface CostTracker {
    setModel(model: string): void;
    add(usage: UsageInfo | undefined, model?: string): void;
    addReportedUsage(entries: Record<string, ModelUsageEntry>): void;
    readonly totalCostUsd: number;
    readonly totalInputTokens: number;
    readonly totalOutputTokens: number;
    readonly totalCacheCreationTokens: number;
    readonly totalCacheReadTokens: number;
    readonly totalTokens: number;
    isOverBudget(maxBudgetUsd: number): boolean;
    reset(): void;
    getUsage(): {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens: number;
        cache_read_input_tokens: number;
    };
    getModelUsage(): Record<string, ModelUsageEntry>;
    addChildCost(child: CostTracker): void;
    summary(): string;
}
