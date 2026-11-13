import type { ToolDefinition, ToolUseBlock } from '../../types/provider.js';

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
  input: { tool: string; arguments: string | Record<string, unknown> };
  rawInput?: string;
  normalization?: string[];
}

/** Host-added text around the unchanged, internally generated search payload. */
export interface ToolDiscoveryEnvelope {
  prefix: string;
  suffix: string;
}

export interface ToolPresentation {
  callId: string;
  definitions: string[];
  guides: string[];
  /** UTF-16 offsets into the string result; omitted for a result containing only the payload. */
  payloadOffset?: number;
  payloadLength?: number;
}

/** Private journal data; provider requests and public events must omit it. */
export interface ToolContextRecord {
  version: 1 | 2;
  baseline?: ToolContextSnapshot;
  /** True only for a disposable directory/recovery attachment, not a summary carrying its metadata. */
  baselineAttachment?: boolean;
  discoveries?: { callId: string; definitions: ToolDefinitionSnapshot[] }[];
  calls?: ToolCallOrigin[];
  rejectedCalls?: { id: string; name: string }[];
  directCalls?: { id: string; name: string }[];
  /** Complete definitions shown by a successful search; never a discovery grant. */
  presentations?: ToolPresentation[];
}

export interface NormalizedToolCall {
  call: ToolUseBlock;
  origin?: ToolCallOrigin;
  error?: string;
}
