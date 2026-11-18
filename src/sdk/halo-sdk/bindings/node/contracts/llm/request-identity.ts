export interface RequestIdentity {
    headers?: Record<string, string>;
    headersForAttempt?: (attempt: number, options?: {
        signal?: AbortSignal;
    }) => Record<string, string> | Promise<Record<string, string>>;
    systemPrefix?: (messages: Array<{
        role: string;
        content: unknown;
    }>, options?: {
        signal?: AbortSignal;
    }) => {
        type: 'text';
        text: string;
    } | Promise<{
        type: 'text';
        text: string;
    }>;
    systemPrefixMessages?: 'first-user-text';
    metadata?: Record<string, string>;
    betaQueryParam?: boolean;
    contextManagement?: Record<string, unknown>;
}
