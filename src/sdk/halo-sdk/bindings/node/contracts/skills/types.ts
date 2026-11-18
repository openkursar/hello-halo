export interface SkillMetadata {
    description: string;
    whenToUse?: string;
    argumentHint?: string;
}
export type SkillSource = {
    kind: 'file';
    path: string;
} | {
    kind: 'builtin';
    name: string;
};
export interface SkillEntry extends SkillMetadata {
    name: string;
    source: SkillSource;
}
export type SkillCatalog = readonly SkillEntry[];
