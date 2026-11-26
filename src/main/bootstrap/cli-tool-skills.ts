import { subscribeToolSkillSync } from '../apps/skills'
import type { AppManagerService } from '../apps/manager'
import {
  getPreparedCurrentToolsRevision, onDidChangeCurrentTools, prepareCliTools, readCurrentToolSkills, recordCliToolSkill,
} from '../services/cli-tools'

type SkillManager = Pick<AppManagerService, 'reconcileManagedToolSkill' | 'removeManagedToolSkill' | 'listManagedToolSkillIds'>

/**
 * Keep each usable CLI tool's skill installed beside its launchers, and record
 * in the tool's installation which skill file belongs to it. Starts once the
 * tool store is prepared and the App Manager exists, whichever comes last.
 */
export function createCliToolSkillStartup(stampPath: string) {
  let sync: ReturnType<typeof subscribeToolSkillSync> | undefined
  let finishManagerStartup!: () => void
  const managerStartup = new Promise<void>(resolve => { finishManagerStartup = resolve })
  let managerFinished = false

  return {
    attachManager(manager: SkillManager) {
      if (managerFinished) return
      sync = subscribeToolSkillSync({
        stampPath,
        onDidChange: onDidChangeCurrentTools,
        readSnapshot: readCurrentToolSkills,
        upsert: async skill => {
          const path = await manager.reconcileManagedToolSkill(skill)
          await recordCliToolSkill(skill.toolId, skill.installId, path ? { name: skill.name, path } : null)
        },
        remove: toolId => manager.removeManagedToolSkill(toolId),
        listManagedIds: () => manager.listManagedToolSkillIds(),
      })
      managerFinished = true
      finishManagerStartup()
    },
    async prepareInBackground() {
      await prepareCliTools()
      // Skills follow once the App Manager exists; the idle queue does not wait for it.
      void managerStartup.then(() => sync?.afterPrepare(getPreparedCurrentToolsRevision()))
    },
    dispose() {
      managerFinished = true
      finishManagerStartup()
      const disposed = sync?.dispose()
      sync = undefined
      return disposed
    },
  }
}
