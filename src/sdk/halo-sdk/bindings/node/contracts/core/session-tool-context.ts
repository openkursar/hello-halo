import type { TranscriptOptions } from "./transcript.js";
export type SessionToolContextMode = 'deferred' | 'full';
export interface ReadSessionToolContextModeOptions extends TranscriptOptions {
    cwd: string;
    resumeSessionAt?: string;
}
