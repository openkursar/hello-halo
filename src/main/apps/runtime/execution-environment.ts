import { existsSync, mkdirSync, statSync } from 'fs'
import { join } from 'path'
import type { AppManagerService, InstalledApp } from '../manager'
import type { ExecutionEnvironment } from '../../../shared/apps/app-types'
import { getSpace, getSpaceDir } from '../../services/space.service'
import type { ActivityStore } from './store'

/** Capture paths once; resuming a task must not reinterpret its default space. */
export function resolveExecutionEnvironment(
  app: InstalledApp,
  manager: Pick<AppManagerService, 'getAppWorkDir' | 'listEffectiveMcpApps'>,
  spaceId: string | null = app.spaceId,
  mode: 'chat' | 'automation' = 'automation',
): ExecutionEnvironment {
  const space = spaceId ? getSpace(spaceId) : null
  if (!space || !spaceId) throw new Error(`Work space is unavailable for app ${app.id}`)
  const workDir = getSpaceDir(spaceId)
  if (!existsSync(space.path)) throw new Error('The work space storage is unavailable. Restore it before continuing.')
  if (app.dataPath && !existsSync(app.dataPath)) throw new Error('The digital human memory directory is unavailable. Restore it before continuing.')
  if (space.isTemp) mkdirSync(workDir, { recursive: true })
  const declared = new Set((app.spec.requires?.mcps ?? []).filter(dependency => dependency.enabled !== false).map(dependency => dependency.id))
  const denied = new Set((app.spec.requires?.mcps ?? []).filter(dependency => dependency.enabled === false).map(dependency => dependency.id))
  return {
    spaceId,
    spacePath: space.path,
    workDir,
    memoryDir: manager.getAppWorkDir(app.id),
    mcpBindings: Object.fromEntries(manager.listEffectiveMcpApps(spaceId)
      .filter(resource => resource.status === 'active' && (mode === 'chat' ? !denied.has(resource.specId) : declared.has(resource.specId)))
      .map(resource => [resource.specId, resource.id])),
  }
}

export function appChatRunId(conversationId: string, appId: string): string {
  const prefix = `app-chat:${appId}`
  return conversationId === prefix ? 'chat' : `chat-${conversationId.slice(prefix.length + 1).replace(/:/g, '-')}`
}

export function teamEnvironmentKey(appId: string, teamId: string): string {
  return `team-environment:${appId}:${teamId}`
}

export function resolveChatEnvironment(
  app: InstalledApp,
  manager: Pick<AppManagerService, 'getAppWorkDir' | 'listEffectiveMcpApps'>,
  store: Pick<ActivityStore, 'getSessionEnvironment' | 'pinSessionEnvironment'>,
  conversationId: string,
  teamId?: string,
): ExecutionEnvironment {
  const prior = store.getSessionEnvironment(conversationId)
    ?? store.getSessionEnvironment(legacySessionEnvironmentKey(app.id, appChatRunId(conversationId, app.id)))
  const teamKey = teamId ? teamEnvironmentKey(app.id, teamId) : undefined
  const candidate = prior ?? (teamKey ? store.getSessionEnvironment(teamKey) : undefined)
    ?? resolveExecutionEnvironment(app, manager, app.spaceId, 'chat')
  validateExecutionEnvironment(candidate)
  if (teamKey) store.pinSessionEnvironment(teamKey, app.id, candidate)
  return store.pinSessionEnvironment(conversationId, app.id, candidate)
}

export function validateEnvironmentConnections(
  environment: ExecutionEnvironment,
  app: InstalledApp,
  manager: Pick<AppManagerService, 'listEffectiveMcpApps'>,
  mode: 'chat' | 'automation' = 'automation',
): void {
  if (!environment.mcpBindings || !environment.spaceId) return
  const authorized = new Set((app.spec.requires?.mcps ?? []).filter(dependency => dependency.enabled !== false).map(dependency => dependency.id))
  const denied = new Set((app.spec.requires?.mcps ?? []).filter(dependency => dependency.enabled === false).map(dependency => dependency.id))
  const effective = manager.listEffectiveMcpApps(environment.spaceId)
  for (const [specId, instanceId] of Object.entries(environment.mcpBindings)) {
    if (mode === 'chat' ? denied.has(specId) : !authorized.has(specId)) continue
    const current = effective.find(resource => resource.specId === specId && resource.status === 'active')
    if (current?.id !== instanceId) {
      console.warn('[Runtime] Original connection unavailable; continuation blocked', { appId: app.id, specId, instanceId })
      throw new Error('An original connection is unavailable or was replaced. Restore it or start new work; Halo will not switch accounts automatically.')
    }
  }
}

export function legacySessionEnvironmentKey(appId: string, runId: string): string {
  return `legacy-file:${appId}:${runId}`
}

/** An unavailable original environment blocks continuation instead of moving it. */
export function validateExecutionEnvironment(environment: ExecutionEnvironment): void {
  if (!environment.spaceId || !getSpace(environment.spaceId)) {
    throw new Error('The original work space is unavailable. Restore it before continuing.')
  }
  for (const path of [environment.workDir, environment.spacePath, environment.memoryDir]) {
    if (!path || !existsSync(path) || !statSync(path).isDirectory()) {
      throw new Error('The original working directory, history or memory is unavailable. Restore it before continuing.')
    }
  }
}

export function getLegacyAppDataPath(app: InstalledApp): string | undefined {
  if (app.dataPath) return app.dataPath
  const space = app.spaceId ? getSpace(app.spaceId) : null
  return space ? join(space.path, '.halo', 'apps', app.id) : undefined
}
