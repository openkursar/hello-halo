import type { Tool } from "../../../types/tool.js";
import type { ToolDefinitionSnapshot } from "./types.js";
export interface ToolCatalog {
    eager: Tool[];
    deferred: Map<string, ToolDefinitionSnapshot>;
    directory: string;
    generation: string;
    search(query: string, server?: string): ToolDefinitionSnapshot[];
}
