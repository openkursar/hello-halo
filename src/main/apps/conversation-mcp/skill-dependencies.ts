/**
 * What create_automation_app and update_automation_app do with a digital
 * human's skill dependencies. The AI declares them; these only normalize the
 * ids, pick which still need installing, and phrase what the AI should check —
 * never adding a dependency on its behalf.
 *
 * Pure over the loadable skills and a Store lookup the caller passes in.
 */

import type { AutomationSpec } from '../spec'
import type { SkillDependency } from '../../../shared/apps/spec-types'
import { findReferencedSkillNames, skillDependencyId } from '../../../shared/apps/skill-references'
import { findLoadableSkill, findUndeclaredSkills, normalizeSkillDependencies, type LoadableSkill } from '../skill-discovery'

/** Whether installers can fetch `id` from the Store. */
export type StoreSkillLookup = (id: string) => boolean

/**
 * A spec about to be created: its dependencies normalized, the ones this space
 * cannot load yet (installed right after creation), and the local skills its
 * prompt names without declaring.
 */
export function prepareCreatedSkills(spec: AutomationSpec, loadable: LoadableSkill[]): {
  spec: AutomationSpec
  toInstall: SkillDependency[]
  undeclared: string[]
} {
  const normalized: AutomationSpec = spec.requires?.skills
    ? { ...spec, requires: { ...spec.requires, skills: normalizeSkillDependencies(spec.requires.skills, loadable) } }
    : spec
  return {
    spec: normalized,
    toInstall: (normalized.requires?.skills ?? []).filter(dep => !findLoadableSkill(loadable, dep)),
    undeclared: findUndeclaredSkills(normalized, loadable).map(skill => skill.id),
  }
}

/** A hint for a failed dependency install, when some id names nothing the Store serves. */
export function createFailureHint(toInstall: SkillDependency[], isListed: StoreSkillLookup): string {
  const bundled = (dep: SkillDependency) => typeof dep !== 'string' && dep.bundled === true
  const unlisted = toInstall.some(dep => !bundled(dep) && !isListed(skillDependencyId(dep)))
  return unlisted ? ' (Declare a skill in this space by its folder name.)' : ''
}

/**
 * What an update leaves to check. A prompt edit reports only the skills the
 * new prompt starts naming, so a dependency left out on purpose is not raised
 * again; declared skills this space cannot load are split by whether the
 * Store serves them.
 */
export function reviewUpdatedSkills(input: {
  previousPrompt: string
  spec: AutomationSpec
  promptChanged: boolean
  skillsChanged: boolean
  loadable: LoadableSkill[]
  isListed: StoreSkillLookup
}): { undeclared: string[]; notInstalled: string[]; unknown: string[] } {
  const { previousPrompt, spec, loadable, isListed } = input
  const undeclared = input.promptChanged
    ? findUndeclaredSkills(spec, loadable)
      .filter(skill => findReferencedSkillNames(previousPrompt, [skill.folder]).length === 0)
      .map(skill => skill.id)
    : []
  if (!input.skillsChanged) return { undeclared, notInstalled: [], unknown: [] }
  const absent = (spec.requires?.skills ?? []).filter(dep => !findLoadableSkill(loadable, dep)).map(skillDependencyId)
  const notInstalled = absent.filter(isListed)
  return { undeclared, notInstalled, unknown: absent.filter(id => !notInstalled.includes(id)) }
}

/** Local skills the prompt names that requires.skills lacks; whether each is a dependency is the caller's call. */
export function undeclaredSkillsNote(ids: string[]): string {
  return ids.length > 0
    ? ` The system prompt names these local skills, which requires.skills does not declare: ${ids.join(', ')}. ` +
      'If the digital human uses them, add them (publishing packages only declared skills); a skill name can also be an ordinary word.'
    : ''
}

/** Declared Store skills this space cannot load; update_automation_app installs nothing. */
export function notInstalledSkillsNote(ids: string[]): string {
  return ids.length > 0
    ? ` These declared skills are in the Store but not installed in this space: ${ids.join(', ')}. ` +
      'Updating does not install them, so the digital human runs without them here until they are installed; whoever installs it from the Store gets them.'
    : ''
}

export function unknownSkillsNote(ids: string[]): string {
  return ids.length > 0
    ? ` requires.skills names skills this space cannot load and the Store does not list: ${ids.join(', ')}. ` +
      'Check each id — use the folder name of a skill in this space.'
    : ''
}
