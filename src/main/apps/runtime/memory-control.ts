/**
 * A digital human's memory as its owner sees it from settings: status, and
 * "consolidate now". Also the consolidation inputs every turn hands over, so a
 * run, a chat and the owner's button consolidate with the same model.
 */

import { getAppManager, type InstalledApp } from '../manager'
import { getApiCredentials, getApiCredentialsForSource } from '../../services/agent/helpers'
import { resolveCredentialsForSdk } from '../../services/agent/sdk-config'
import { getSpace } from '../../services/space.service'
import { resolveMemoryLayout, type MemoryCallerScope } from '../../platform/memory'
import type { MemoryStatus } from '../../../shared/types/memory'
import { hasOtherAppExecution } from './live-instances'
import { consolidateNow, getMemoryStatus } from '../../services/memory-consolidation'
import {
  appMemorySettings,
  appConsolidationRequest,
  type AppConsolidationInputs,
} from './turn/memory-lifecycle'

/**
 * @param selfId - The execution asking, left out of "is anyone else running".
 *                 Absent when the owner asks from settings.
 */
export function appConsolidationInputs(app: InstalledApp, selfId?: string): AppConsolidationInputs {
  return {
    appName: app.spec.name,
    settings: appMemorySettings(app),
    resolveCredentials: async () => {
      const credentials = app.userOverrides?.modelSourceId
        ? await getApiCredentialsForSource(app.userOverrides.modelSourceId, app.userOverrides.modelId)
        : await getApiCredentials()
      return resolveCredentialsForSdk(credentials)
    },
    isBusy: () => hasOtherAppExecution(app.id, selfId),
  }
}

/** The memory scope of a digital human, as settings see it (its own data folder). */
function ownerScope(app: InstalledApp): MemoryCallerScope | null {
  const manager = getAppManager()
  if (!manager || !app.spaceId) return null
  const space = getSpace(app.spaceId)
  return {
    type: 'app',
    spaceId: app.spaceId,
    spacePath: space?.path ?? '',
    appId: app.id,
    appDataPath: manager.getAppWorkDir(app.id),
  }
}

export async function getDigitalHumanMemoryStatus(appId: string): Promise<MemoryStatus | null> {
  const app = getAppManager()?.getApp(appId)
  const scope = app ? ownerScope(app) : null
  return scope ? getMemoryStatus(resolveMemoryLayout(scope, 'app')) : null
}

export function consolidateDigitalHumanMemoryNow(appId: string): { started: boolean; reason?: string } {
  const app = getAppManager()?.getApp(appId)
  const scope = app ? ownerScope(app) : null
  if (!app || !scope) return { started: false, reason: 'not-found' }
  // Runs on what is there, even with memory off.
  return consolidateNow(appConsolidationRequest(scope, appConsolidationInputs(app), `app:${appId.slice(0, 8)}`))
}
