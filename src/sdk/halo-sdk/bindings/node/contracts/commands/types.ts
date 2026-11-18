import type { Message } from "../../types/provider.js";
export type CommandSource = 'builtin' | 'user';
export type CommandKind = 'local' | 'prompt';
export interface SlashCommandResult {
    kind: 'system';
    markdown: string;
}
export interface SessionCostSnapshot {
    totalCostUsd: number;
    totalDurationMs: number;
    totalApiDurationMs: number;
    numTurns: number;
    tokens: {
        input: number;
        output: number;
        cacheCreate: number;
        cacheRead: number;
    };
}
export interface SlashCommandContext {
    readonly sessionId: string;
    readonly cwd: string;
    readonly model: string;
    setModel(model: string): void;
    readonly mcpServerStatuses: ReadonlyArray<{
        name: string;
        status: string;
    }>;
    readonly messages: readonly Message[];
    clearMessages(): void | Promise<void>;
    compactSession(instructions?: string): Promise<void>;
    getCostSnapshot(): SessionCostSnapshot;
    readonly commands: ReadonlyArray<Command>;
}
export interface CommandBase {
    name: string;
    description: string;
    aliases?: string[];
    argumentHint?: string;
    whenToUse?: string;
    isEnabled?: () => boolean;
    isHidden?: boolean;
    userInvocable?: boolean;
    source?: CommandSource;
}
export interface LocalCommand extends CommandBase {
    type: 'local';
    call?: (args: string, ctx: SlashCommandContext) => Promise<SlashCommandResult>;
}
export interface PromptCommand extends CommandBase {
    type: 'prompt';
    getPromptForCommand?: (args: string, ctx: SlashCommandContext) => Promise<Message[]>;
}
export type Command = LocalCommand | PromptCommand;
