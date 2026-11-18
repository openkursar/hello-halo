import type { Message } from "../../types/provider.js";
export interface ApiTokenAnchor {
    anchor(apiInputTokens: number, localEstimate: number): void;
    estimateWithAnchor(messages: Message[]): number;
    readonly lastApiTokens: number;
    readonly hasAnchor: boolean;
    reset(): void;
}
