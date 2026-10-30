/**
 * Skill references in a digital human's system prompt.
 *
 * A prompt that tells the agent to use a skill depends on that skill, but the
 * runtime never needs it declared (every skill in scope loads anyway), so the
 * dependency used to go unrecorded — and publishing then shipped the digital
 * human without the skill. These helpers find the skills a prompt names so the
 * create/update tools and the publish dialog can flag the undeclared ones.
 *
 * Pure and renderer-safe: callers supply the skill names that may load
 * (apps/skill-discovery resolves them against disk and installed apps).
 */

import type { Requires, SkillDependency } from './spec-types'

/** Names shorter than this collide with ordinary words too often to match. */
const MIN_NAME_LENGTH = 3

/** Characters that continue a skill name; a match must not touch one on either side. */
const NAME_CHAR = '[A-Za-z0-9_-]'

/** The id a `requires.skills` entry declares, string or object form. */
export function skillDependencyId(dep: SkillDependency): string {
  return typeof dep === 'string' ? dep : dep.id
}

/** Which of `candidates` appear in `text` as whole names (case-insensitive). */
export function findReferencedSkillNames(text: string, candidates: Iterable<string>): string[] {
  if (!text) return []
  const found: string[] = []
  for (const name of new Set(candidates)) {
    if (name.length < MIN_NAME_LENGTH) continue
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(?<!${NAME_CHAR})${escaped}(?!${NAME_CHAR})`, 'i').test(text)) found.push(name)
  }
  return found.sort()
}

/** `requires` with the `ids` it does not already declare appended to its skills. */
export function withDeclaredSkills(requires: Requires | undefined, ids: string[]): Requires {
  const skills = requires?.skills ?? []
  const present = new Set(skills.map(dep => skillDependencyId(dep).toLowerCase()))
  const added = ids.filter(id => {
    const key = id.toLowerCase()
    if (present.has(key)) return false
    present.add(key)
    return true
  })
  return { ...requires, skills: [...skills, ...added.map(id => ({ id }))] }
}
