/**
 * What a digital human can lend beyond its switches, loaded the way its own
 * sessions get it: the skills its space can load, and the MCP servers that
 * space runs, less paused ones and ones the digital human turned off itself.
 * A wider list would let a screen call "not everything" what enforcement
 * reads as everything.
 */

import { api } from '../../api'
import type { AvailableSkill, InstalledApp } from '../../../shared/apps/app-types'
import type { LendableInventory } from '../../../shared/apps/capability-policy'

export interface LendableItems {
  skills: AvailableSkill[]
  userMcp: InstalledApp[]
}

/** Null when either list cannot be read: a guess here would be shown as fact. */
export async function loadLendableItems(app: InstalledApp): Promise<LendableItems | null> {
  if (!app.spaceId) return null
  const [skills, servers] = await Promise.all([
    api.appListAvailableSkills(app.id),
    api.appListEffectiveMcpApps(app.spaceId),
  ])
  if (!skills.success || !servers.success) return null
  const turnedOff = new Set(
    (app.spec.requires?.mcps ?? []).filter(dependency => dependency.enabled === false).map(dependency => dependency.id)
  )
  return {
    skills: skills.data ?? [],
    userMcp: (servers.data ?? []).filter(server => server.status !== 'paused' && !turnedOff.has(server.specId)),
  }
}

export function inventoryOf(items: LendableItems): LendableInventory {
  return {
    skills: [...new Set(items.skills.map(skill => skill.dirName))],
    userMcp: items.userMcp.map(server => server.specId),
  }
}
