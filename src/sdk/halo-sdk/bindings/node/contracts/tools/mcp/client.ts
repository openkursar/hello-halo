export interface McpServerCapabilities {
    tools?: Record<string, unknown>;
    resources?: Record<string, unknown>;
    prompts?: Record<string, unknown>;
}
export interface McpServerInfo {
    name: string;
    version: string;
    description?: string;
}
export interface McpToolDefinition {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, unknown>;
}
export interface McpCallToolResult {
    content: Array<{
        type: string;
        text?: string;
        data?: string;
        mimeType?: string;
        [key: string]: unknown;
    }>;
    isError?: boolean;
}
export type McpElicitationHandler = (request: Record<string, unknown>, options: {
    signal: AbortSignal;
}) => Promise<Record<string, unknown>>;
export interface McpClient {
    readonly initialized: boolean;
    getServerInfo(): McpServerInfo | null;
    getTools(): McpToolDefinition[];
    getInstructions(): string | undefined;
    initialize(): Promise<void>;
    callTool(toolName: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallToolResult>;
    close(): void;
    whenClosed(): Promise<void>;
}
