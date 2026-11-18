import type { PermissionMode } from "../../types/config.js";
import type { Goal,GoalInput } from "../../types/goal.js";
import type { SDKMessage } from "./query-types.js";
export interface InputOptions {
    onConsumed?: () => void;
}
export interface LiveInputOptions extends InputOptions {
    onWithdrawn?: () => void;
}
export interface SessionCloseOptions {
    signal?: AbortSignal;
}
export interface SessionRuntimeStats {
    pendingInputs: number;
    activeCollaborators: number;
    sharedCostUsd?: number;
}
export interface SDKSession {
    readonly sessionId: string;
    send(message: string | Record<string, unknown>, options?: InputOptions): Promise<void>;
    hasPendingInput(): boolean;
    getRuntimeStats(): Promise<SessionRuntimeStats>;
    sendIntoLiveTurn(message: string | Record<string, unknown>, options?: LiveInputOptions): boolean;
    withdrawUnreadInput(): Promise<number>;
    stream(): AsyncGenerator<SDKMessage, void, undefined>;
    close(options?: SessionCloseOptions): void;
    flush(): Promise<void>;
    interrupt(): Promise<void>;
    setModel(model: string | undefined): Promise<void>;
    setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void>;
    setPermissionMode(mode: PermissionMode): Promise<void>;
    getGoal(): Goal | null;
    setGoal(goal: GoalInput | null): Goal | null;
    [Symbol.asyncDispose](): Promise<void>;
}
