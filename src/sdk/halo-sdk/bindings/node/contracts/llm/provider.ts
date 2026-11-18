import type { ProviderQuirks } from "./openai-compat.js";
export interface ProviderConfig {
    type?: 'anthropic' | 'openai-compat';
    apiKey: string;
    baseUrl?: string;
    defaultModel?: string;
    headers?: Record<string, string>;
    apiVersion?: string;
    betas?: string[];
    quirks?: ProviderQuirks;
    providerId?: string;
    providerName?: string;
}
export type { AnthropicProviderConfig } from "./anthropic.js";
export type { OpenAiCompatProviderConfig,ProviderQuirks } from "./openai-compat.js";
