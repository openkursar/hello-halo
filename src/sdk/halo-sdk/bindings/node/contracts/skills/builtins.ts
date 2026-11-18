import type { SkillMetadata } from "./types.js";
export interface BuiltinSkillDefinition extends Readonly<SkillMetadata> {
    readonly name: string;
    readonly instructions: string;
}
