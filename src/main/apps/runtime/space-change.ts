import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import type { AppSpaceChangePreview } from '../../../shared/apps/app-environment'
import type { ExecutionEnvironment } from '../../../shared/apps/app-types'
import { buildImSessionKey } from '../../../shared/apps/im-keys'
import type { AppManagerService, InstalledApp } from '../manager'
import { getTeamStore } from '../team'
import { listAvailableSkills } from '../skill-discovery'
import { getSpace } from '../../services/space.service'
import type { ActivityStore } from './store'
import type { AppRuntimeService } from './types'
import { getImSessionRegistry } from './im-session-registry'
import { resolveExecutionEnvironment, validateExecutionEnvironment, legacySessionEnvironmentKey, teamEnvironmentKey, appChatRunId } from './execution-environment'

interface SpaceChangeDependencies {
  manager: AppManagerService
  store: ActivityStore
  runtime: AppRuntimeService
}

function getTarget(deps: SpaceChangeDependencies, appId: string, newSpaceId: string) {
  const app = deps.manager.getApp(appId)
  if (!app || app.status === 'uninstalled') throw new Error('Digital human is unavailable')
  if (app.spec.type !== 'automation') throw new Error('Default work space applies to digital humans')
  if (!app.spaceId || typeof newSpaceId !== 'string' || !getSpace(newSpaceId)) throw new Error('Work space is unavailable')
  return app
}

function legacyTranscriptIds(spacePath: string, appId: string): string[] {
  const runsDir = join(spacePath, '.halo', 'apps', appId, 'runs')
  if (!existsSync(runsDir)) return []
  return readdirSync(runsDir).filter(file =>
    (file === 'chat.jsonl' || (file.startsWith('chat-') && file.endsWith('.jsonl'))) &&
    statSync(join(runsDir, file)).size > 0
  ).map(file => file.slice(0, -6))
}

/** Pin legacy records before changing the only default from which their origin is known. */
export function retainAppEnvironments(manager: AppManagerService, store: ActivityStore, app: InstalledApp): void {
  const environment = resolveExecutionEnvironment(app, manager)
  validateExecutionEnvironment(environment)
  store.pinRunEnvironments(app.id, environment)
  const chatEnvironment = resolveExecutionEnvironment(app, manager, app.spaceId, 'chat')
  for (const runId of legacyTranscriptIds(environment.spacePath, app.id)) {
    store.pinSessionEnvironment(legacySessionEnvironmentKey(app.id, runId), app.id, chatEnvironment)
  }
  for (const session of getImSessionRegistry()?.getAllSessions(app.id) ?? []) {
    const key = buildImSessionKey(app.id, session.channel, session.chatType, session.chatId)
    const prior = store.getSessionEnvironment(legacySessionEnvironmentKey(app.id, appChatRunId(key, app.id)))
    store.pinSessionEnvironment(key, app.id, prior ?? chatEnvironment)
  }
  for (const membership of getTeamStore()?.listMembersByAppId(app.id) ?? []) {
    store.pinSessionEnvironment(teamEnvironmentKey(app.id, membership.teamId), app.id, chatEnvironment)
  }
  store.pinSessionEnvironment(`environment-backfill:${app.id}`, app.id, environment)
}

function retainedSessionCount(store: ActivityStore, app: InstalledApp): number {
  const keys = new Set<string>()
  const legacyPrefix = `legacy-file:${app.id}:`
  const currentPath = app.spaceId ? getSpace(app.spaceId)?.path : undefined
  for (const item of store.listSessionEnvironments(app.id)) {
    if (!item.sessionKey.startsWith(`app-chat:${app.id}`) && !item.sessionKey.startsWith(legacyPrefix)) continue
    const runId = item.sessionKey.startsWith(legacyPrefix) ? item.sessionKey.slice(legacyPrefix.length) : appChatRunId(item.sessionKey, app.id)
    if (runId === 'chat' || runId.startsWith('chat-')) keys.add(runId)
  }
  if (currentPath) for (const runId of legacyTranscriptIds(currentPath, app.id)) keys.add(runId)
  for (const session of getImSessionRegistry()?.getAllSessions(app.id) ?? []) {
    keys.add(appChatRunId(buildImSessionKey(app.id, session.channel, session.chatType, session.chatId), app.id))
  }
  return keys.size
}

export function previewAppSpaceChange(
  deps: SpaceChangeDependencies,
  appId: string,
  newSpaceId: string,
): AppSpaceChangePreview {
  const app = getTarget(deps, appId, newSpaceId)
  const beforeSkills = listAvailableSkills(app.spaceId!)
  const afterSkills = listAvailableSkills(newSpaceId)
  const declared = new Set((app.spec.requires?.mcps ?? []).filter(dependency => dependency.enabled !== false).map(dependency => dependency.id))
  const connections = (spaceId: string) => deps.manager.listEffectiveMcpApps(spaceId)
    .filter(resource => declared.has(resource.specId) && resource.status === 'active')
  const denied = new Set((app.spec.requires?.mcps ?? []).filter(dependency => dependency.enabled === false).map(dependency => dependency.id))
  const chatConnections = (spaceId: string) => deps.manager.listEffectiveMcpApps(spaceId)
    .filter(resource => !denied.has(resource.specId) && resource.status === 'active')
  const beforeChatConnections = chatConnections(app.spaceId!)
  const afterChatConnections = chatConnections(newSpaceId)
  const beforeConnections = connections(app.spaceId!)
  const afterConnections = connections(newSpaceId)
  const difference = <T>(left: T[], right: T[], key: (item: T) => string) => left.filter(item => !right.some(other => key(other) === key(item)))
  const skillLabel = (skill: typeof beforeSkills[number], spaceId: string) => `${skill.name} (${skill.scope === 'global' ? 'Global' : getSpace(spaceId)?.name ?? spaceId})`
  const connectionLabel = (resource: InstalledApp) => `${resource.spec.name} (${resource.spaceId ? getSpace(resource.spaceId)?.name ?? resource.spaceId : 'Global'})`
  const state = deps.runtime.getAppState(appId)
  const warnings: string[] = []
  if ([...declared].some(id => !afterConnections.some(resource => resource.specId === id))) warnings.push('Some declared connections are unavailable in the destination workspace.')
  const target = getSpace(newSpaceId)!
  if (!existsSync(target.workingDir || target.path)) warnings.push('The destination working directory is unavailable. Restore it before starting new work.')
  return {
    appId, fromSpaceId: app.spaceId, toSpaceId: newSpaceId,
    activeRunCount: state.runningCount ?? (state.status === 'running' ? 1 : 0),
    pendingDecisionCount: deps.store.getDecisionCounts(appId).pending,
    retainedSessionCount: retainedSessionCount(deps.store, app),
    addedSkills: difference(afterSkills, beforeSkills, skill => skill.path).map(skill => skillLabel(skill, newSpaceId)),
    removedSkills: difference(beforeSkills, afterSkills, skill => skill.path).map(skill => skillLabel(skill, app.spaceId!)),
    addedConnections: difference(afterConnections, beforeConnections, resource => resource.id).map(connectionLabel),
    removedConnections: difference(beforeConnections, afterConnections, resource => resource.id).map(connectionLabel),
    addedChatConnections: difference(afterChatConnections, beforeChatConnections, resource => resource.id).map(connectionLabel),
    removedChatConnections: difference(beforeChatConnections, afterChatConnections, resource => resource.id).map(connectionLabel),
    warnings,
  }
}

export async function changeAppDefaultSpace(
  deps: SpaceChangeDependencies,
  appId: string,
  newSpaceId: string,
): Promise<void> {
  const app = getTarget(deps, appId, newSpaceId)
  if (app.spaceId === newSpaceId) return
  const destination = resolveExecutionEnvironment(app, deps.manager, newSpaceId)
  validateExecutionEnvironment(destination)
  retainAppEnvironments(deps.manager, deps.store, app)
  await deps.manager.moveToSpace(appId, newSpaceId)
  deps.runtime.syncAppSubscriptions(appId)
  console.log(`[Runtime] Default space changed: app=${appId}, from=${app.spaceId}, to=${newSpaceId}; existing work retained`)
}
