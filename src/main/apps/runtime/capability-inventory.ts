import type { AppManagerService } from '../manager'
import { getCapabilityInventory } from '../manager'
import { getTeamStore } from '../team'
import { parseTeamSessionKey } from '../../../shared/apps/im-keys'
import type { RetainedCapabilityBinding } from '../../../shared/apps/capability-inventory'
import type { ActivityStore } from './store'

/** Inventory impact includes resumable old work without exposing its conversation content. */
export function buildAppCapabilityInventory(manager: AppManagerService, store: ActivityStore) {
  const retained: RetainedCapabilityBinding[] = []
  const epochs = new Map<string, boolean>()
  for (const work of store.listRetainedCapabilityEnvironments()) {
    if (!work.environment.mcpBindings) continue
    if (work.sessionKey) {
      // Legacy team transcripts without a canonical session cannot prove a live epoch.
      if (work.sessionKey.startsWith(`legacy-file:${work.appId}:chat-team-`)) continue
      const team = parseTeamSessionKey(work.sessionKey)
      if (team) {
        if (!epochs.has(team.epochId)) {
          const epoch = getTeamStore()?.getEpochById(team.epochId)
          epochs.set(team.epochId, !!epoch && epoch.endedAt === null && epoch.workItem?.status !== 'completed')
        }
        if (!epochs.get(team.epochId)) continue
      }
    }
    retained.push({ appId: work.appId, bindings: work.environment.mcpBindings, mode: work.sessionKey ? 'chat' : 'automation' })
  }
  return getCapabilityInventory(manager, retained)
}
