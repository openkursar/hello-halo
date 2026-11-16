import type { ToolDefinition,ToolUseBlock } from "../../../types/provider.js";
export interface ToolDefinitionSnapshot {
    server: string;
    identity: string;
    originalName: string;
    version: string;
    definition: ToolDefinition;
    usageGuide?: string;
}
export interface ToolContextSnapshot {
    version: 1;
    discoveryEntries: boolean;
    generation: string;
    directory: string;
    definitions: ToolDefinitionSnapshot[];
    historicalDefinitions?: ToolDefinitionSnapshot[];
}
export interface ToolCallOrigin {
    id: string;
    definitionVersion: string;
    input: {
        tool: string;
        arguments: string | Record<string, unknown>;
    };
    rawInput?: string;
    normalization?: string[];
}
export interface ToolDiscoveryEnvelope {
    prefix: string;
    suffix: string;
}
export interface ToolPresentation {
    callId: string;
    definitions: string[];
    guides: string[];
    payloadOffset?: number;
    payloadLength?: number;
}
export interface ToolContextRecord {
    version: 1 | 2;
    baseline?: ToolContextSnapshot;
    baselineAttachment?: boolean;
    discoveries?: {
        callId: string;
        definitions: ToolDefinitionSnapshot[];
    }[];
    calls?: ToolCallOrigin[];
    rejectedCalls?: {
        id: string;
        name: string;
    }[];
    directCalls?: {
        id: string;
        name: string;
    }[];
    presentations?: ToolPresentation[];
}
export interface NormalizedToolCall {
    call: ToolUseBlock;
    origin?: ToolCallOrigin;
    error?: string;
}
