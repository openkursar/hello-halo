import type { AgentConventions } from "./conventions.js";
export interface TranscriptOptions {
    env?: Record<string, string | undefined>;
    conventions?: Partial<AgentConventions>;
}
