export interface JsonRpcRequest {
    jsonrpc: '2.0';
    id: number;
    method: string;
    params?: unknown;
}
export interface JsonRpcNotification {
    jsonrpc: '2.0';
    method: string;
    params?: unknown;
}
export interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: number;
    result?: unknown;
    error?: JsonRpcError;
}
export interface JsonRpcError {
    code: number;
    message: string;
    data?: unknown;
}
export type ServerRequestHandler = (params: unknown) => Promise<unknown>;
export interface McpTransport {
    connect(): Promise<void>;
    send(request: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse>;
    notify(notification: JsonRpcNotification): Promise<void>;
    close(): void;
    whenClosed?(): Promise<void>;
    readonly connected: boolean;
    setRequestHandler(method: string, handler: ServerRequestHandler): void;
}
