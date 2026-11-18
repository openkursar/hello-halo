export interface StdioTransportOptions {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
}
export interface SSETransportOptions {
    url: string;
    headers?: Record<string, string>;
}
export interface HttpTransportOptions {
    url: string;
    headers?: Record<string, string>;
}
