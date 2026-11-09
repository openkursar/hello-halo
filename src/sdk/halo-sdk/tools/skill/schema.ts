/**
 * @module tools/skill/schema
 * Skill tool schema and configuration.
 * @license MIT
 */

export const SKILL_TOOL_NAME = 'Skill';

export const SKILL_TOOL_DESCRIPTION = `Load a named skill's instructions into this conversation. The tool returns text to follow; it does not run a separate agent or execute the workflow itself.

Choose a skill from the available catalog when the user names it or its description fits the requested work. Load its instructions before performing the specialized work. Use skill="list" to inspect the catalog; args can narrow that list by a name fragment. For other skills, args supplies request details.

Repository commit and pull-request or merge-request tasks may have a matching workflow in the catalog. The selected workflow still follows the user's authorization and repository rules.

A slash command may already have expanded a skill into a <skill-instructions> block. Follow that body directly instead of loading it a second time. After compaction, reload a needed skill if only its name remains. Ordinary local commands such as /help are handled by the command system, not by this tool.`;

export const SKILL_TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    skill: {
      type: 'string',
      description:
        'A catalog name, such as "commit", or "list" to inspect available skills.',
    },
    args: {
      type: 'string',
      description:
        'Request details substituted into the selected skill template.',
    },
  },
  required: ['skill'],
} as const;
