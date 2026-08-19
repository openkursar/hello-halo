/**
 * Skill directory naming
 *
 * A skill app's on-disk directory name is its specId sanitized by this rule.
 * Shared because main (skill-sync writes the directory) and renderer
 * (AppSkillsSection matches disk directories back to installed apps) must
 * apply the exact same mapping.
 */

export function toSkillDirName(specId: string): string {
  return specId.replace(/[^a-zA-Z0-9_-]/g, '_')
}
