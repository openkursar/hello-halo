/** Shared discovery and loading contract for every skill entry point. */
export { getBuiltinSkillDefinitions } from './builtins.js';
export type { BuiltinSkillDefinition } from './builtins.js';
export { discoverSkillFiles, loadSkill, normalizeSkillName, readSkillMetadata, resolveSkill, resolveSkillCatalog, snapshotSkillCatalog, skillSearchDirs } from './resolver.js';
export type { LoadedSkill, SkillCatalog, SkillContext, SkillEntry, SkillMetadata, SkillSource } from './types.js';
