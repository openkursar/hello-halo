import type { Command } from "./types.js";
export type CommandList = readonly Command[];
export interface CommandRegistry {
    register(cmd: Command): void;
    unregister(name: string): boolean;
    get(name: string): Command | undefined;
    has(name: string): boolean;
    list(): CommandList;
    listUserInvocable(): CommandList;
    size(): number;
    clear(): void;
}
