import type { CollaborationServer } from "../../../collaboration/types.js";
import type { ModelUsageEntry } from "../../core/cost.js";
import type { ExecutionBudget } from "../../core/execution-budget.js";
export interface LocalCollaborationOptions {
    maxConcurrentTurns?: number;
    maxMembers?: number;
    idleTimeoutMs?: number;
    maxRecords?: number;
    maxBytes?: number;
    maxIdleSessions?: number;
}
export interface SdkCollaborationBinding {
    server: CollaborationServer;
    readonly budget: ExecutionBudget;
    drainUsage(): Record<string, ModelUsageEntry>;
    readonly activeCount: number;
    readonly residentCount: number;
    readonly retainedCount: number;
    readonly revision: number;
    waitForChange(after: number, signal?: AbortSignal): Promise<void>;
    beginRequest(): void;
    stopAll(): Promise<void>;
    flush(): Promise<void>;
    close(): Promise<void>;
}
