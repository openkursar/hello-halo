import type { AgentConventions } from '../core/conventions.js';

export interface SkillContext {
  cwd: string;
  env?: Record<string, string | undefined>;
  conventions?: AgentConventions;
  /** Sources advertised by this session; bodies are still read on invocation. */
  skillCatalog?: SkillCatalog;
}

export interface SkillMetadata {
  description: string;
  whenToUse?: string;
  argumentHint?: string;
}

export type SkillSource =
  | { kind: 'file'; path: string }
  | { kind: 'builtin'; name: string };

export interface SkillEntry extends SkillMetadata {
  name: string;
  source: SkillSource;
}

export type SkillCatalog = readonly SkillEntry[];

export interface LoadedSkill {
  name: string;
  source: SkillSource;
  prompt: string;
}
