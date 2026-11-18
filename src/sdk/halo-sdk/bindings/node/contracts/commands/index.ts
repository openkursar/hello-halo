import type { SlashCommand } from "../../types/config.js";
import type { CommandRegistry } from "./registry.js";
import type { Command,CommandBase,CommandKind,CommandSource,LocalCommand,PromptCommand,SessionCostSnapshot,SlashCommandContext,SlashCommandResult } from "./types.js";
export type { Command,CommandBase,CommandKind,CommandRegistry,CommandSource,LocalCommand,PromptCommand,SessionCostSnapshot,SlashCommandContext,SlashCommandResult };
export interface BuildSessionRegistryOptions {
    user?: ReadonlyArray<string | SlashCommand | Command>;
    skills?: ReadonlyArray<Command>;
}
