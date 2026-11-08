import { TEAM_CIRCUIT_DEFAULTS } from '../../../shared/apps/team-types'

export interface TeamCircuitLimits {
  maxMessages: number
  maxForwardDepth: number
}

export type TeamCircuitLimitsOverride = Partial<TeamCircuitLimits>

/**
 * A number input updates the page state as the user types, so the blur handler
 * can no longer compare against that state. Compare against the saved config
 * instead, and persist only the fields that differ, merged over the stored
 * overrides. Returns the fields saved, or null when nothing changed.
 */
export async function saveTeamCircuitLimitChange(
  saved: TeamCircuitLimitsOverride | undefined,
  patch: TeamCircuitLimitsOverride,
  save: (config: { teamCircuitLimits: TeamCircuitLimitsOverride }) => Promise<unknown>,
): Promise<TeamCircuitLimitsOverride | null> {
  const next: TeamCircuitLimitsOverride = {}
  for (const key of Object.keys(patch) as (keyof TeamCircuitLimits)[]) {
    const value = patch[key]
    if (value === undefined) continue
    if ((saved?.[key] ?? TEAM_CIRCUIT_DEFAULTS[key]) === value) continue
    next[key] = value
  }
  if (Object.keys(next).length === 0) return null

  await save({ teamCircuitLimits: { ...saved, ...next } })
  return next
}
