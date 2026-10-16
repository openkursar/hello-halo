/**
 * A member's delegated policy as its owner sees and changes it.
 *
 * Read the way a request from another computer is held to it (`colleagueReach`),
 * never more loosely, so the switches show what such a request actually gets.
 * Pure: the screens load the inventory and save the result.
 */

import {
  CAPABILITY_MCP_TOGGLES,
  CAPABILITY_PRESET_IDS,
  DELEGABLE_BUILTIN_TOOLS,
  allowsBuiltin,
  allowsCapability,
  allowsSkill,
  allowsUserMcp,
  capabilityPolicyFromPreset,
  colleagueReach,
  fullCapabilityPolicy,
  grantsEverything,
  resolveBashAccess,
} from '../../../shared/apps/capability-policy'
import type {
  CapabilityMode,
  CapabilityPresetId,
  LendableInventory,
} from '../../../shared/apps/capability-policy'
import type { TeamDelegatedPolicy } from '../../../shared/apps/team-types'

export interface DelegatedPolicyView {
  /** Never saved: another computer gets everything, an IM guest of the team nothing. */
  unset: boolean
  /** What the switches show and edit. */
  policy: TeamDelegatedPolicy
  mode: CapabilityMode
}

/** The periodic-check answer is not a capability, so every rewrite carries it over. */
function keepChecksAnswer(from: TeamDelegatedPolicy | null | undefined): Pick<TeamDelegatedPolicy, 'allowChecks'> {
  return from?.allowChecks === false ? { allowChecks: false } : {}
}

/**
 * When everything is lent, the switches edit an explicit list of everything
 * rather than the saved form: under a strict reading an unlisted skill or
 * server is a "no", so turning one switch off would otherwise turn every
 * unlisted one off with it.
 */
export function delegatedPolicyView(
  saved: TeamDelegatedPolicy | null | undefined,
  inventory: LendableInventory,
): DelegatedPolicyView {
  if (saved && colleagueReach(saved, inventory) === 'strict') {
    return { unset: false, policy: saved, mode: 'strict' }
  }
  return {
    unset: !saved,
    policy: {
      ...fullCapabilityPolicy(),
      allowedSkills: [...inventory.skills],
      allowedUserMcp: [...inventory.userMcp],
      ...keepChecksAnswer(saved),
    },
    mode: 'permissive',
  }
}

/**
 * What a change on the screen saves. Everything lent is saved unlisted, so a
 * skill or server installed later is lent too and "all on" keeps meaning all.
 */
export function delegatedPolicyToSave(
  next: TeamDelegatedPolicy,
  inventory: LendableInventory,
): TeamDelegatedPolicy {
  if (!grantsEverything(next, inventory)) return next
  return { ...fullCapabilityPolicy(), ...keepChecksAnswer(next) }
}

/** A preset, applied over whatever was saved before. */
export function withPreset(
  saved: TeamDelegatedPolicy | null | undefined,
  preset: CapabilityPresetId,
): TeamDelegatedPolicy {
  return { ...capabilityPolicyFromPreset(preset), ...keepChecksAnswer(saved) }
}

const NOTHING_LENDABLE: LendableInventory = { skills: [], userMcp: [] }

/**
 * The invite answer a saved policy amounts to, judged by what a request from
 * another computer gets under it; null when it is none of them. Never saved
 * reads as everything, because that is what it grants.
 */
export function presetOfDelegatedPolicy(
  saved: TeamDelegatedPolicy | null | undefined,
  inventory?: LendableInventory,
): CapabilityPresetId | null {
  if (colleagueReach(saved, inventory) === 'full') return 'full'
  const lendable = inventory ?? NOTHING_LENDABLE
  return CAPABILITY_PRESET_IDS.find(id => id !== 'full' && grantsLikePreset(saved!, id, lendable)) ?? null
}

/** The presets other than "everything" never list commands, so the command scope alone decides. */
function grantsLikePreset(saved: TeamDelegatedPolicy, id: CapabilityPresetId, inventory: LendableInventory): boolean {
  const preset = capabilityPolicyFromPreset(id)
  return (
    DELEGABLE_BUILTIN_TOOLS.every(({ name }) => allowsBuiltin(saved, name, 'strict') === allowsBuiltin(preset, name, 'strict')) &&
    resolveBashAccess(saved, 'strict').scope === resolveBashAccess(preset, 'strict').scope &&
    CAPABILITY_MCP_TOGGLES.every(({ key }) => allowsCapability(saved, key, 'strict') === allowsCapability(preset, key, 'strict')) &&
    inventory.skills.every(skill => allowsSkill(saved, skill, 'strict') === allowsSkill(preset, skill, 'strict')) &&
    inventory.userMcp.every(id => allowsUserMcp(saved, id, 'strict') === allowsUserMcp(preset, id, 'strict'))
  )
}
