import { subscribeToolSkillSync } from '../apps/skills'
import type { AppManagerService } from '../apps/manager'
import { getPreparedCurrentToolsRevision, onDidChangeCurrentTools, prepareCliTools, readCurrentToolSkills } from '../services/cli-tools'

type SkillManager = Pick<AppManagerService, 'reconcileManagedToolSkill' | 'removeManagedToolSkill' | 'listManagedToolSkillIds'>

/** Share static skill readiness between the first user session and the background preparation. */
export function createCliToolSkillStartup(stampPath: string) {
  let sync: ReturnType<typeof subscribeToolSkillSync> | undefined
  let finishManagerStartup!: () => void
  const managerStartup = new Promise<void>(resolve => { finishManagerStartup = resolve })
  let managerFinished = false

  function afterPrepare(): Promise<void> | undefined {
    if (!managerFinished) return managerStartup.then(afterPrepare)
    return sync?.afterPrepare(getPreparedCurrentToolsRevision())
  }

  return {
    attachManager(manager: SkillManager) {
      if (managerFinished) return
      sync = subscribeToolSkillSync({
        stampPath,
        onDidChange: onDidChangeCurrentTools,
        readSnapshot: readCurrentToolSkills,
        upsert: skill => manager.reconcileManagedToolSkill(skill),
        remove: toolId => manager.removeManagedToolSkill(toolId),
        listManagedIds: () => manager.listManagedToolSkillIds(),
      })
      managerFinished = true
      finishManagerStartup()
    },
    async prepareInBackground() {
      await prepareCliTools()
      await afterPrepare()
    },
    afterPrepare,
    dispose() {
      managerFinished = true
      finishManagerStartup()
      const disposed = sync?.dispose()
      sync = undefined
      return disposed
    },
  }
}
