import type { SkillDependency } from './spec-types'

/** The object form of a skill dependency (the string form is a bare id). */
export interface BundledSkillDep {
  id: string
  reason?: string
  bundled?: boolean
  files?: string[]
}

/** Skill dependencies packaged inside the app, not merely declared. This is the
 * single rule for "ships with the app": both publish packaging and the publish
 * form's co-list UI resolve bundled skills through it. */
export function bundledSkillDeps(deps: SkillDependency[] | undefined): BundledSkillDep[] {
  return (deps ?? []).filter(
    (d): d is BundledSkillDep => typeof d !== 'string' && d.bundled === true,
  )
}
