import type { Tool, ToolContext, ToolResult } from '../../types/tool.js';
import { toolSuccess, toolError } from '../../types/tool.js';
import { getLogger } from '../../utils/logger.js';
import { discoverSkillFiles, loadSkill, normalizeSkillName, readSkillMetadata, resolveSkill, resolveSkillCatalog, skillSearchDirs } from '../../skills/index.js';
import type { SkillContext } from '../../skills/index.js';
import { SKILL_TOOL_NAME, SKILL_TOOL_DESCRIPTION, SKILL_TOOL_INPUT_SCHEMA } from './schema.js';

// Keep existing module imports working while discovery belongs to skills/.
export { discoverSkillFiles, readSkillMetadata, skillSearchDirs } from '../../skills/index.js';

export function scanDiskSkills(
  dirs: string[],
  readDesc: (filePath: string) => string = filePath => readSkillMetadata(filePath).description,
): Array<[string, string]> {
  return discoverSkillFiles(dirs).map(([name, filePath]) => [name, readDesc(filePath)]);
}

export function collectDiskSkills(ctx: SkillContext): Array<[string, string]> {
  return scanDiskSkills(skillSearchDirs(ctx), filePath => {
    const description = readSkillMetadata(filePath).description || '(no description)';
    return description.length > 200 ? `${description.slice(0, 200)}…` : description;
  });
}

export const SkillTool: Tool = {
  name: SKILL_TOOL_NAME,
  description: SKILL_TOOL_DESCRIPTION,
  inputSchema: SKILL_TOOL_INPUT_SCHEMA as unknown as Record<string, unknown>,
  permissionLevel: 'none',
  isConcurrencySafe: () => true,

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (typeof input.skill !== 'string' || !input.skill.trim()) {
      getLogger('Skills').warn('Skill invocation rejected', { reason: 'missing skill name' });
      return toolError('Missing required parameter: skill');
    }
    if (input.args !== undefined && typeof input.args !== 'string') {
      getLogger('Skills').warn('Skill invocation rejected', { reason: 'arguments must be text' });
      return toolError('Skill arguments must be a string.');
    }
    const name = normalizeSkillName(input.skill);
    if (!name) {
      getLogger('Skills').warn('Skill invocation rejected', { reason: 'invalid catalog name' });
      return toolError('Use an exact skill name from the catalog, without a file path.');
    }
    if (name.toLowerCase() === 'list') {
      const query = typeof input.args === 'string' ? input.args.trim().toLowerCase() : '';
      const catalog = resolveSkillCatalog(ctx).filter(entry => !query || entry.name.toLowerCase().includes(query));
      const lines = [`Available skills (${catalog.length}):`];
      let length = lines[0].length;
      let included = 0;
      for (const entry of catalog) {
        const line = `  ${entry.name} — ${(entry.description || '(no description)').replace(/\s+/g, ' ').slice(0, 200)}`;
        if (length + line.length > 15_800) break;
        lines.push(line);
        length += line.length + 1;
        included++;
      }
      if (included < catalog.length) lines.push(`${catalog.length - included} entries omitted. Repeat skill="list" with args set to a name fragment to narrow the list.`);
      return toolSuccess(lines.join('\n'));
    }
    const entry = resolveSkill(name, ctx);
    if (!entry) {
      getLogger('Skills').warn('Skill invocation rejected', { name, reason: 'not found' });
      return toolError(`Skill '${name}' not found. Use skill="list" to see available skills.`);
    }
    try {
      const loaded = await loadSkill(entry, input.args as string | undefined);
      return toolSuccess(loaded.prompt, { skill: { name: loaded.name, source: loaded.source } });
    } catch (error) {
      return toolError(error instanceof Error ? error.message : `Skill '${name}' could not be loaded.`);
    }
  },
};
