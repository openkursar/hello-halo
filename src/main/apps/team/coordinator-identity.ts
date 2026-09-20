import type { AppManagerService } from '../manager'
import type { TeamStore } from './store'
import { provisionLeadSpec } from './lead'

/** Backfill only exact system templates; custom or ambiguous leads remain visible. */
export function reconcileCoordinatorIdentity(store: TeamStore, manager: AppManagerService): number {
  let updated = 0
  for (const team of store.listTeams()) {
    if (!team.leadAppId) continue
    const member = store.getMember(team.id, team.leadAppId)
    if (!member || member.isSystemCoordinator || !member.aiProvisioned || !member.isLead) continue
    const app = manager.getApp(member.appId)
    if (!app || app.spec.type !== 'automation') continue
    const expected = provisionLeadSpec({ teamName: team.name, goal: team.goal, owningSpaceId: team.owningSpaceId }).spec
    if (app.spec.system_prompt !== expected.system_prompt || app.spec.author !== expected.author || app.spec.description !== expected.description) continue
    store.markSystemCoordinator(team.id, member.appId)
    updated++
  }
  if (updated) console.log(`[TeamService] Recovered dedicated coordinator identities: count=${updated}`)
  return updated
}
