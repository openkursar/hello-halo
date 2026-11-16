export type ToolCallingMode = 'native' | 'xml' | 'json';
export type ModelFamily = 'anthropic' | 'openai' | 'google' | 'deepseek' | 'qwen' | 'glm' | 'kimi' | 'minimax' | 'unknown' | string;
export interface ModelAdapter {
    readonly family: ModelFamily;
    readonly preferredToolCallingMode: ToolCallingMode;
    adaptToolDescription?(description: string): string;
    adaptSystemPrompt?(prompt: string): string;
    requestDefaults?: {
        temperature?: number;
        topP?: number;
    };
}
export interface ParsedToolCall {
    name: string;
    parameters: Record<string, unknown>;
    rawXml: string;
}
export interface ParseResult {
    textContent: string;
    toolCalls: ParsedToolCall[];
    unreadable?: string;
}
