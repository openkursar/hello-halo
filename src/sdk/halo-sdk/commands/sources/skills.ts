import type { Command, PromptCommand } from '../types.js';
import { DEFAULT_CONVENTIONS, type AgentConventions } from '../../core/conventions.js';
import { loadSkill, resolveSkillCatalog, type SkillCatalog, type SkillEntry } from '../../skills/index.js';

export interface LoadSkillCommandsOptions {
  cwd: string;
  configDir?: string;
  env?: Record<string, string | undefined>;
  conventions?: AgentConventions;
  enabled?: boolean;
  skillCatalog?: SkillCatalog;
}

export function loadSkillCommands(options: LoadSkillCommandsOptions): Command[] {
  if (options.enabled === false) return [];
  const conventions = options.conventions ?? DEFAULT_CONVENTIONS;
  const env = { ...(options.env ?? process.env) };
  if (options.configDir !== undefined) env[conventions.configDirEnv] = options.configDir;
  return resolveSkillCatalog({ cwd: options.cwd, env, conventions, skillCatalog: options.skillCatalog }).map(buildSkillCommand);
}

function buildSkillCommand(entry: SkillEntry): PromptCommand {
  return {
    type: 'prompt',
    name: entry.name,
    description: entry.description,
    source: entry.source.kind === 'builtin' ? 'builtin' : 'user',
    ...(entry.whenToUse ? { whenToUse: entry.whenToUse } : {}),
    ...(entry.argumentHint ? { argumentHint: entry.argumentHint } : {}),
    async getPromptForCommand(args: string) {
      const loaded = await loadSkill(entry, args);
      return [{
        role: 'user',
        content: `<skill-instructions name="${loaded.name}">\n${loaded.prompt}\n</skill-instructions>`,
      }];
    },
  };
}
