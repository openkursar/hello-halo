import { existsSync, readdirSync, statSync } from 'fs'
import { mkdir, open, realpath, stat } from 'fs/promises'
import { join, resolve } from 'path'
import { isPathWithin } from '../../foundation/path-containment'
import type { AppSpaceChangePreview } from '../../../shared/apps/app-environment'
import type { ExecutionEnvironment } from '../../../shared/apps/app-types'
import { buildImSessionKey } from '../../../shared/apps/im-keys'
import type { AppManagerService, InstalledApp } from '../manager'
import { getTeamStore, getTeamService } from '../team'
import { beginTeamWorkspaceChange, prepareTeamWorkspaceChange } from './team'
import { getTaskStateService } from '../../platform/task-state'
import { listAvailableSkills } from '../skill-discovery'
import { getSpace, getHaloSpace } from '../../services/space.service'
import { copyStoredSessions, WorkingDirectoryUnavailableError } from '../../services/agent'
import { resolveMemoryLayout } from '../../platform/memory'
import { suspendMemoryConsolidation } from '../../services/memory-consolidation'
import { sendToRenderer } from '../../foundation/window.service'
import { broadcastToAll } from '../../http/websocket'
import { acquireAppWorkspaceChange, awaitWorkspaceDrain } from './workspace-admission'
import { countAppChats, stopAndDrainAppChats } from './app-chat'
import { mutateWorkspace } from './workspace-mutations'
import type { ActivityStore } from './store'
import type { AppRuntimeService } from './types'
import { getImSessionRegistry } from './im-session-registry'
import { buildExecutionEnvironment, resolveExecutionEnvironment, validateExecutionEnvironment, legacySessionEnvironmentKey, teamEnvironmentKey, appChatRunId } from './execution-environment'

interface SpaceChangeDependencies {
  manager: AppManagerService
  store: ActivityStore
  runtime: AppRuntimeService
}

type AppDataSource = { path: string; spaceId: string; targetPath?: string }

const MAX_SESSION_BINDINGS_BYTES = 16 * 1024 * 1024

function getTarget(deps: SpaceChangeDependencies, appId: string, newSpaceId: string) {
  const app = deps.manager.getApp(appId)
  if (!app || app.status === 'uninstalled') throw new Error('Digital human is unavailable')
  if (app.spec.type !== 'automation') throw new Error('Default work space applies to digital humans')
  // A space-less digital human is a legal source: it inherits no space skills
  // and IM binding refuses it, so this is its only way out. Only the
  // destination has to exist.
  if (typeof newSpaceId !== 'string' || !getSpace(newSpaceId)) throw new Error('Work space is unavailable')
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
  const fromSpaceId = app.spaceId
  const afterSkills = listAvailableSkills(newSpaceId)
  // A space-less source inherits nothing from a work space, so what it can
  // reach today is exactly the global-scope subset of the destination's view.
  const beforeSkills = fromSpaceId ? listAvailableSkills(fromSpaceId) : afterSkills.filter(skill => skill.scope === 'global')
  const effectiveMcp = (spaceId: string | null) => spaceId
    ? deps.manager.listEffectiveMcpApps(spaceId)
    : deps.manager.listEffectiveMcpApps(newSpaceId).filter(resource => !resource.spaceId)
  const declared = new Set((app.spec.requires?.mcps ?? []).filter(dependency => dependency.enabled !== false).map(dependency => dependency.id))
  const connections = (spaceId: string | null) => effectiveMcp(spaceId)
    .filter(resource => declared.has(resource.specId) && resource.status === 'active')
  const denied = new Set((app.spec.requires?.mcps ?? []).filter(dependency => dependency.enabled === false).map(dependency => dependency.id))
  const chatConnections = (spaceId: string | null) => effectiveMcp(spaceId)
    .filter(resource => !denied.has(resource.specId) && resource.status === 'active')
  const beforeChatConnections = chatConnections(fromSpaceId)
  const afterChatConnections = chatConnections(newSpaceId)
  const beforeConnections = connections(fromSpaceId)
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
    activeRunCount: deps.runtime.getAppWorkspaceWorkCount?.(appId) ?? state.runningCount ?? (state.status === 'running' ? 1 : 0),
    activeChatCount: countAppChats(appId),
    pendingDecisionCount: deps.store.getDecisionCounts(appId).pending,
    retainedSessionCount: retainedSessionCount(deps.store, app),
    addedSkills: difference(afterSkills, beforeSkills, skill => skill.path).map(skill => skillLabel(skill, newSpaceId)),
    removedSkills: difference(beforeSkills, afterSkills, skill => skill.path).map(skill => skillLabel(skill, fromSpaceId ?? newSpaceId)),
    addedConnections: difference(afterConnections, beforeConnections, resource => resource.id).map(connectionLabel),
    removedConnections: difference(beforeConnections, afterConnections, resource => resource.id).map(connectionLabel),
    addedChatConnections: difference(afterChatConnections, beforeChatConnections, resource => resource.id).map(connectionLabel),
    removedChatConnections: difference(beforeChatConnections, afterChatConnections, resource => resource.id).map(connectionLabel),
    warnings,
  }
}

export function changeAppDefaultSpace(deps: SpaceChangeDependencies, appId: string, newSpaceId: string): Promise<void> {
  return mutateWorkspace(async () => {
    const app = getTarget(deps, appId, newSpaceId)
    if (app.spaceId === newSpaceId && !app.dataPath) return
    await relocateAppWorkspace(deps, appId, newSpaceId)
  })
}

async function pathIdentity(path: string): Promise<string> {
  try { return await realpath(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return resolve(path)
  }
}

async function appDataSources(app: InstalledApp, store: ActivityStore, target: string): Promise<AppDataSource[]> {
  const candidates: AppDataSource[] = []
  const currentSpace = app.spaceId ? getSpace(app.spaceId) : null
  for (const environment of store.listAppEnvironments(app.id)) {
    const spaceId = environment.spaceId ?? 'legacy'
    if (environment.spacePath) candidates.push({ path: join(environment.spacePath, '.halo', 'apps', app.id), spaceId })
    if (environment.memoryDir) candidates.push({ path: environment.memoryDir, spaceId })
  }
  if (app.dataPath) candidates.push({ path: app.dataPath, spaceId: app.spaceId ?? 'legacy' })
  if (currentSpace) candidates.push({ path: join(currentSpace.path, '.halo', 'apps', app.id), spaceId: currentSpace.id })
  const seen = new Set([await pathIdentity(target)])
  const sources: AppDataSource[] = []
  for (const source of candidates) {
    const identity = await pathIdentity(source.path)
    if (seen.has(identity)) continue
    seen.add(identity)
    sources.push(source)
  }
  return sources
}

async function nativeSessionIds(paths: Iterable<string>, runIds: string[]): Promise<Set<string>> {
  const ids = new Set(runIds)
  for (const root of paths) {
    let handle: Awaited<ReturnType<typeof open>>
    try { handle = await open(join(root, 'runs', '_session-ids.json'), 'r') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > MAX_SESSION_BINDINGS_BYTES) throw new Error('Session bindings are unavailable for workspace relocation')
      const map: unknown = JSON.parse(await handle.readFile('utf8'))
      if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('Session bindings are invalid for workspace relocation')
      for (const value of Object.values(map)) {
        if (typeof value === 'string') ids.add(value)
        else if (value && typeof value === 'object') {
          const binding = value as { sessionId?: unknown; legacySessionId?: unknown }
          const id = binding.sessionId ?? binding.legacySessionId
          if (typeof id === 'string') ids.add(id)
        }
      }
    } finally { await handle.close() }
  }
  return ids
}

async function carryActorSessions(store: ActivityStore, appId: string, environment: ExecutionEnvironment, previousEnvironment?: ExecutionEnvironment): Promise<void> {
  const previous = [...store.listAppEnvironments(appId), ...(previousEnvironment ? [previousEnvironment] : [])]
  const roots = new Set(previous.map(item => join(item.spacePath, '.halo', 'apps', appId)))
  roots.add(join(environment.spacePath, '.halo', 'apps', appId))
  const ids = await nativeSessionIds(roots, store.listAppNativeSessionIds(appId))
  if (!ids.size) return
  try {
    if (!(await stat(environment.workDir)).isDirectory()) return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    console.warn('[Runtime] Collaborator native history carry deferred: working directory is unavailable', { appId })
    return
  }
  for (const workDir of new Set(previous.map(item => item.workDir))) {
    if (workDir && workDir !== environment.workDir) await copyStoredSessions(workDir, environment.workDir, undefined, ids)
  }
}

async function ensureDestination(environment: ExecutionEnvironment): Promise<void> {
  const space = getSpace(environment.spaceId!)
  if (!space) throw new Error('The destination workspace is unavailable')
  if (space.isTemp) await mkdir(environment.workDir, { recursive: true })
  try {
    if (!(await stat(environment.workDir)).isDirectory()) throw new WorkingDirectoryUnavailableError(environment.workDir, environment.spaceId!)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    throw new WorkingDirectoryUnavailableError(environment.workDir, environment.spaceId!)
  }
}

/** Caller holds workspace mutation ordering; every writer is drained before any file moves. */
export async function relocateAppWorkspace(deps: SpaceChangeDependencies, appId: string, newSpaceId: string, deletingSpacePath?: string): Promise<void> {
  const app = deps.manager.getApp(appId)
  if (!app || app.spec.type !== 'automation') throw new Error('Digital human is unavailable')
  const destination = buildExecutionEnvironment(app, deps.manager, newSpaceId)
  const priorEnvironments = deps.store.listAppEnvironments(appId)
  const team = getTeamService() ? beginTeamWorkspaceChange({ appId, sourceSpaceId: app.spaceId,
    sourceWorkDirs: priorEnvironments.map(environment => environment.workDir),
    targetEnvironment: destination, targetAppRoot: destination.memoryDir, deletingSpacePath }) : undefined
  const initialActors = new Set(team?.actorIds ?? [appId])
  const releaseAdmission = await acquireAppWorkspaceChange(initialActors)
  const releaseData = deps.manager.holdWorkspaceData([appId])
  try {
    await ensureDestination(destination)
    const sources = await appDataSources(app, deps.store, destination.memoryDir)
    const layouts = [...sources.map(source => source.path), destination.memoryDir].map(appDataPath => resolveMemoryLayout({
      type: 'app', spaceId: newSpaceId, spacePath: destination.spacePath, appId, appDataPath,
    }, 'app'))
    const memory = suspendMemoryConsolidation(layouts)
    const stopped = deps.runtime.getAppWorkspaceWorkCount(appId) + countAppChats(appId)
    console.log('[Runtime] Moving digital human workspace', { appId, from: app.spaceId, to: newSpaceId, stopped })
    let releaseAddedActors: (() => void) | undefined
    try {
      const teamPlan = await team?.drain()
      const actors = teamPlan?.actorIds ?? [appId]
      const additional = actors.filter(id => !initialActors.has(id))
      if (additional.length) releaseAddedActors = await acquireAppWorkspaceChange(additional)
      await Promise.all(actors.map(async id => {
        if (id === appId) await deps.runtime.stopAndDrainAppRuns(id)
        await stopAndDrainAppChats(id)
      }))
      await awaitWorkspaceDrain(appId, 'memory consolidation', memory.drain())
      for (const relocation of teamPlan?.relocations ?? []) {
        if (sources.some(source => isPathWithin(relocation.sourcePath, source.path))) continue
        sources.push({ path: relocation.sourcePath, targetPath: relocation.targetPath, spaceId: app.spaceId ?? 'legacy' })
      }
      const environments = deps.store.listAppEnvironments(appId)
      const workDirs = new Set(environments.map(environment => environment.workDir))
      const priorSpace = app.spaceId ? getSpace(app.spaceId) : null
      if (priorSpace) workDirs.add(priorSpace.isTemp ? join(priorSpace.path, 'artifacts') : priorSpace.workingDir || priorSpace.path)
      workDirs.delete(destination.workDir)
      const appRoots = sources.filter(source => !source.targetPath).map(source => source.path)
      const ids = await nativeSessionIds([...appRoots, destination.memoryDir], deps.store.listAppNativeSessionIds(appId))
      for (const workDir of workDirs) if (workDir && ids.size) await copyStoredSessions(workDir, destination.workDir, undefined, ids)
      for (const actor of teamPlan?.environments ?? []) await carryActorSessions(deps.store, actor.appId, actor.environment, actor.previousEnvironment)
      const chatEnvironment = buildExecutionEnvironment(app, deps.manager, newSpaceId, 'chat')
      // Only conversations in a deleted workspace are told; an explicit move was chosen by the reader.
      const notice = deletingSpacePath ? { kind: 'deleted' as const, fromSpacePath: deletingSpacePath } : undefined
      const moved = await deps.manager.relocateAutomationData(appId, newSpaceId, {
        sources,
        commitEnvironments: () => {
          deps.store.relocateAppEnvironments(appId, chatEnvironment, destination, notice)
          for (const actor of teamPlan?.environments ?? []) deps.store.relocateAppEnvironments(actor.appId, actor.environment, actor.environment, notice)
          teamPlan?.commitEnvironment()
          getTaskStateService()?.repointAppConversations(appId, newSpaceId)
        },
      })
      getTaskStateService()?.notifyStateChanged()
      deps.runtime.syncAppSubscriptions(appId)
      const change = { appId, change: 'updated' }
      sendToRenderer('app:list_changed', change)
      broadcastToAll('app:list_changed', change)
      console.log('[Runtime] Digital human workspace moved', { appId, from: app.spaceId, to: newSpaceId, files: moved.fileCount, stopped })
    } finally {
      memory.release()
      releaseAddedActors?.()
    }
  } finally {
    releaseData()
    releaseAdmission()
    team?.release()
  }
}

/** Runs before subscriptions, IM routing or chat admission can touch app data. */
export async function repairLegacyAppWorkspaces(deps: Pick<SpaceChangeDependencies, 'manager' | 'store'>): Promise<void> {
  const failedRecovery = new Set(await deps.manager.recoverDataRelocations())
  for (const appId of deps.manager.listLegacyDataAppIds()) {
    if (failedRecovery.has(appId)) continue
    const app = deps.manager.getApp(appId)
    if (!app || app.spec.type !== 'automation') continue
    const spaceId = app.spaceId && getSpace(app.spaceId) ? app.spaceId : getHaloSpace().id
    try {
      const destination = buildExecutionEnvironment(app, deps.manager, spaceId)
      const sources = await appDataSources(app, deps.store, destination.memoryDir)
      const teamStore = getTeamStore()
      const teamPlan = teamStore ? prepareTeamWorkspaceChange({ appId, sourceSpaceId: app.spaceId,
        sourceWorkDirs: deps.store.listAppEnvironments(appId).map(environment => environment.workDir),
        targetEnvironment: destination, targetAppRoot: destination.memoryDir }, teamStore) : undefined
      for (const relocation of teamPlan?.relocations ?? []) {
        if (sources.some(source => isPathWithin(relocation.sourcePath, source.path))) continue
        sources.push({ path: relocation.sourcePath, targetPath: relocation.targetPath, spaceId: app.spaceId ?? 'legacy' })
      }
      const ids = await nativeSessionIds([...sources.filter(source => !source.targetPath).map(source => source.path), destination.memoryDir], deps.store.listAppNativeSessionIds(appId))
      if (getSpace(spaceId)?.isTemp) await mkdir(destination.workDir, { recursive: true })
      if (existsSync(destination.workDir) && ids.size) {
        for (const workDir of new Set(deps.store.listAppEnvironments(appId).map(environment => environment.workDir))) {
          if (workDir && workDir !== destination.workDir) await copyStoredSessions(workDir, destination.workDir, undefined, ids)
        }
      }
      for (const actor of teamPlan?.environments ?? []) await carryActorSessions(deps.store, actor.appId, actor.environment, actor.previousEnvironment)
      await deps.manager.relocateAutomationData(appId, spaceId, {
        sources,
        commitEnvironments: () => {
          deps.store.relocateAppEnvironments(appId, buildExecutionEnvironment(app, deps.manager, spaceId, 'chat'), destination)
          for (const actor of teamPlan?.environments ?? []) deps.store.relocateAppEnvironments(actor.appId, actor.environment, actor.environment)
          teamPlan?.commitEnvironment()
          getTaskStateService()?.repointAppConversations(appId, spaceId)
        },
      })
      console.warn('[Runtime] Legacy digital human workspace repaired', { appId, spaceId })
    } catch (error) {
      console.error('[Runtime] Legacy workspace repair failed; retained data remains available for retry', { appId, spaceId, error })
    }
  }
}
