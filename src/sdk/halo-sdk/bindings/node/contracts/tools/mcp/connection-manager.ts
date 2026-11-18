import type { Tool } from "../../../types/tool.js";
import type { McpServerConnectionStatus } from "./bridge.js";
import type { McpElicitationHandler } from "./client.js";
export type McpServerLiveStatus = {
    state: 'connected';
    toolCount: number;
} | {
    state: 'connecting';
} | {
    state: 'disconnected';
    lastError?: string;
} | {
    state: 'failed';
    error: string;
    retryAt: number;
};
export interface McpConnectionManager {
    setElicitationHandler(handler: McpElicitationHandler): void;
    addServer(name: string, config: Record<string, unknown>): void;
    connectAll(): Promise<void>;
    connect(name: string): Promise<void>;
    disconnect(name: string): void;
    disconnectAll(): void;
    whenSettled(): Promise<void>;
    restart(name: string): Promise<void>;
    removeServer(name: string): void;
    toggle(name: string, enabled: boolean): Promise<void>;
    setServers(configs: Record<string, Record<string, unknown>>): Promise<{
        added: string[];
        removed: string[];
        errors: Record<string, string>;
    }>;
    getStatus(name: string): McpServerLiveStatus | undefined;
    getAllStatuses(): Map<string, McpServerLiveStatus>;
    getStatuses(): McpServerConnectionStatus[];
    isConnected(name: string): boolean;
    serverNames(): string[];
    getToolCatalogRevision(): number;
    ownsTool(tool: Tool): boolean;
    getBridgedTools(): Tool[];
    startReconnectLoop(name: string): void;
}
export interface CreateMcpConnectionManagerOptions {
    onElicitation?: McpElicitationHandler;
}
