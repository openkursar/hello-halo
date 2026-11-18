export interface OpenAiCompatProviderConfig {
    id: string;
    name: string;
    baseUrl: string;
    apiKey?: string;
    headers?: Record<string, string>;
    defaultModel?: string;
    quirks?: ProviderQuirks;
}
export interface ProviderQuirks {
    toolIdMaxLen?: number;
    toolIdAlphanumericOnly?: boolean;
    includeUsageInStream?: boolean;
    defaultTemperature?: number;
    fixToolUserSequence?: boolean;
    reasoningField?: string;
    reasoningEffort?: boolean;
}
