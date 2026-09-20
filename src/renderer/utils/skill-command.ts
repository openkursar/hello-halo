/**
 * Skill Trigger Command
 *
 * A skill's slash-command is derived client-side from its spec name — it is
 * not a stored field. Shared so every surface that displays or prefills
 * "how to invoke this skill" computes the identical string.
 */
export function deriveSkillCommand(name: string): string {
  return `/${name.toLowerCase().replace(/\s+/g, '-')}`
}
