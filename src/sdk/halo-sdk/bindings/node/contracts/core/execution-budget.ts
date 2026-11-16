import type { ModelUsageEntry } from "./cost.js";
export interface ExecutionBudget {
    observe(usage: ModelUsageEntry): void;
    readonly spent: number;
    readonly total: number;
    resetRequest(): void;
}
