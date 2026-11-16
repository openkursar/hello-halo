import type { PromptProfileId } from "../../../types/config.js";
export interface PromptProfile {
    readonly id: PromptProfileId;
    readonly version: number;
    readonly conversationGuidance: string;
    readonly summaryGuidance: string;
}
