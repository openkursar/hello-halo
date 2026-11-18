import type { Message,ToolDefinition,ToolUseBlock } from "../../../types/provider.js";
import type { Tool,ToolResult } from "../../../types/tool.js";
import type { ToolCatalog } from "./catalog.js";
import type { NormalizedToolCall,ToolContextRecord,ToolContextSnapshot,ToolDiscoveryEnvelope } from "./types.js";
export interface ToolDiscoveryState {
    readonly catalog: ToolCatalog;
    readonly searchTool: Tool;
    readonly modelDefinitions: ToolDefinition[];
    readonly discoveryEntries: boolean;
    readonly enabled: boolean;
    readonly needsBaseline: boolean;
    baselineCommitted(): void;
    setRecoveryBudget(tokens: number): void;
    snapshot(): ToolContextSnapshot;
    directoryMessage(): Message;
    restore(snapshot: ToolContextSnapshot): void;
    commit(record: ToolContextRecord): void;
    normalize(call: ToolUseBlock): NormalizedToolCall;
    settle(callId: string, result: ToolResult, envelope?: ToolDiscoveryEnvelope): {
        result: ToolResult;
        record?: ToolContextRecord;
    };
    recoveryMessage(): Message;
    finalizeResults(message: Message): void;
    clear(): void;
    finishStep(): void;
    hasSearchResult(callId: string): boolean;
}
