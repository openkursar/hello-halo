import type { PromptProfileSelection } from "../../types/config.js";
import type { Tool } from "../../types/tool.js";
export interface SystemPromptConfig {
    tools: Tool[];
    cwd: string;
    platform?: string;
    gitBranch?: string;
    model: string;
    promptProfile?: PromptProfileSelection;
    ultraEffort?: boolean;
    memoryContent?: string;
    mcpInstructions?: string;
    customAppend?: string;
    customReplace?: string;
}
