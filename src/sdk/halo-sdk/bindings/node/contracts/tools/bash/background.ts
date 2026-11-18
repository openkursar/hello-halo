import type { ShellState } from "../../../types/tool.js";
export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped';
export interface BackgroundTask {
    id: string;
    command: string;
    status: BackgroundTaskStatus;
    outputFile: string;
    outputTruncated?: boolean;
    cwdWarning?: string;
    exitCode: number | null;
    error: string | null;
    pid: number | undefined;
    startedAt: number;
    completedAt: number | null;
    done: Promise<void>;
}
export interface BackgroundTaskRegistry {
    readonly activeCount: number;
    get(id: string): BackgroundTask | undefined;
    getAll(): BackgroundTask[];
    start(options: {
        command: string;
        state: ShellState;
        fallbackCwd?: string;
        env: Record<string, string | undefined>;
        timeoutMs?: number;
        abortSignal: AbortSignal;
    }): Promise<BackgroundTask>;
    stop(id: string): boolean;
    stopAll(): void;
    readOutput(task: BackgroundTask): Promise<{
        output: string;
        truncated: boolean;
    }>;
    dispose(): void;
    flush(): Promise<void>;
}
