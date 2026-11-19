import type { CollaborationServer } from "../../../collaboration/types.js";
import type { ModelUsageEntry } from "../../core/cost.js";
import type { ExecutionBudget } from "../../core/execution-budget.js";
import type { ModelChoicePlan, ModelProfileCatalog, ModelSelectionSnapshot, PreparedModelMetadata } from '../model-selection.js';
import type { ProviderConfig } from '../../../native/provider-factory.js';
import type { LlmProvider } from '../../../types/provider.js';
import type { ModelPricing } from '../../core/cost.js';

export type PreparedModelBinding = PreparedModelMetadata & {
    modelPricing?: ModelPricing;
} & ({ providerConfig: ProviderConfig & { type: 'anthropic' | 'openai-compat' }; provider?: never } | { provider: LlmProvider; providerConfig?: never });
export type ModelPreparationRequest = { kind: 'new'; plan: ModelChoicePlan } | { kind: 'restore'; snapshot: ModelSelectionSnapshot };
export type ModelCatalogUpdate = { kind: 'snapshot'; catalog: ModelProfileCatalog } | { kind: 'unchanged'; revision: string };
export interface LocalModelSelectionHost {
    policy: 'inherit' | 'task';
    policyRevision: string;
    parentBinding: { bindingId: string; restoreRef: string };
    getCatalog(context: { signal: AbortSignal; knownRevision?: string }): ModelCatalogUpdate | Promise<ModelCatalogUpdate>;
    prepare(request: ModelPreparationRequest, context: { signal: AbortSignal }): Promise<PreparedModelBinding>;
}
export interface LocalCollaborationOptions {
    modelSelection?: LocalModelSelectionHost;
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
