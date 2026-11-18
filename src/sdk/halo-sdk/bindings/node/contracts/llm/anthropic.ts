import type { RequestIdentity } from "./request-identity.js";
export interface AnthropicProviderConfig {
    apiKey: string;
    baseUrl?: string;
    apiVersion?: string;
    betas?: string[];
    headers?: Record<string, string>;
    defaultModel?: string;
    requestIdentity?: RequestIdentity;
}
export type { RequestIdentity } from "./request-identity.js";
