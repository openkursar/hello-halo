/**
 * Skill content helpers
 *
 * Patching a skill spec's primary SKILL.md content. Must stay symmetric with
 * the read side (shared/skill-frontmatter getSkillMdContent): skill_files
 * takes priority over skill_content.
 */

import type { SkillSpec } from '../../shared/apps/spec-types'

/**
 * Build the spec patch needed to update SKILL.md content.
 * Preserves all other files in skill_files when present.
 */
export function buildSkillContentPatch(
  spec: SkillSpec,
  newContent: string
): Record<string, unknown> {
  if (spec.skill_files) {
    return { skill_files: { ...spec.skill_files, 'SKILL.md': newContent } }
  }
  return { skill_content: newContent }
}
