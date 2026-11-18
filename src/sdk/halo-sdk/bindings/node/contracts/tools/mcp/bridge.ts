import type { Tool } from "../../../types/tool.js";
export interface McpServerConnectionStatus {
    name: string;
    status: 'connected' | 'failed';
    error?: string;
}
export interface ExternalMcpConnection {
    tools: Tool[];
    serverStatuses: McpServerConnectionStatus[];
    disconnect: () => void;
}
