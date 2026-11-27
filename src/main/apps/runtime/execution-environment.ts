import { mkdirSync, statSync } from 'fs'
import { join } from 'path'
import type { AppManagerService, InstalledApp } from '../manager'
import type { ExecutionEnvironment, MissingConnection } from '../../../shared/apps/app-types'
import { BUILTIN_MCP_SERVER_IDS } from '../../../shared/apps/builtin-mcp'
import { getSpace, getSpaceDir } from '../../services/space.service'
import { WorkingDirectoryUnavailableError } from '../../services/agent'
import type { ActivityStore } from './store'

type EnvironmentManager = Pick<AppManagerService, 'getAppWorkDir' | 'listEffectiveMcpApps'>
  & Partial<Pick<AppManagerService, 'getApp' | 'assertAppDataAvailable'>>

/** Describe a relocation destination without creating it or reading legacy storage. */
export function buildExecutionEnvironment(
  app: InstalledApp,
  manager: Pick<AppManagerService, 'listEffectiveMcpApps'>,
  spaceId: string | null = app.spaceId,
  mode: 'chat' | 'automation' = 'automation',
): ExecutionEnvironment {
  const space = spaceId ? getSpace(spaceId) : null
  if (!space || !spaceId) throw new Error(`Work space is unavailable for app ${app.id}`)
  return {
    spaceId,
    spacePath: space.path,
    workDir: getSpaceDir(spaceId),
    memoryDir: join(space.path, '.halo', 'apps', app.id),
    mcpBindings: connectionBindings(app, manager.listEffectiveMcpApps(spaceId), mode),
  }
}

export function resolveExecutionEnvironment(
  app: InstalledApp,
  manager: EnvironmentManager,
  spaceId: string | null = app.spaceId,
  mode: 'chat' | 'automation' = 'automation',
  storageOnly = false,
): ExecutionEnvironment {
  manager.assertAppDataAvailable?.(app.id)
  const memoryDir = manager.getAppWorkDir(app.id)
  const current = manager.getApp?.(app.id) ?? app
  const environment = buildExecutionEnvironment(current, manager, spaceId === app.spaceId ? current.spaceId : spaceId, mode)
  environment.memoryDir = memoryDir
  const space = getSpace(environment.spaceId!)!
  if (space.isTemp && !storageOnly) {
    mkdirSync(environment.workDir, { recursive: true })
  }
  return storageOnly ? validateEnvironmentStorage(environment) : validateExecutionEnvironment(environment)
}

function connectionBindings(
  app: InstalledApp,
  effective: InstalledApp[],
  mode: 'chat' | 'automation',
): Record<string, string> {
  const declared = new Set((app.spec.requires?.mcps ?? []).filter(dependency => dependency.enabled !== false).map(dependency => dependency.id))
  const denied = new Set((app.spec.requires?.mcps ?? []).filter(dependency => dependency.enabled === false).map(dependency => dependency.id))
  return Object.fromEntries(effective
    .filter(resource => mode === 'chat' ? !denied.has(resource.specId) : declared.has(resource.specId))
    .map(resource => [resource.specId, resource.id]))
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
  manager: EnvironmentManager,
  store: Pick<ActivityStore, 'getSessionEnvironment' | 'pinSessionEnvironment' | 'replaceSessionEnvironment'>,
  conversationId: string,
  teamId?: string,
  storageOnly = false,
): ExecutionEnvironment {
  manager.assertAppDataAvailable?.(app.id)
  const legacyKey = legacySessionEnvironmentKey(app.id, appChatRunId(conversationId, app.id))
  const exact = store.getSessionEnvironment(conversationId)
  const legacy = exact ? undefined : store.getSessionEnvironment(legacyKey)
  const teamKey = teamId ? teamEnvironmentKey(app.id, teamId) : undefined
  const candidate = exact ?? legacy ?? (teamKey ? store.getSessionEnvironment(teamKey) : undefined)
  const validate = storageOnly ? validateEnvironmentStorage : validateExecutionEnvironment
  const environment = candidate ? validate(candidate, {
    app, manager,
    mode: 'chat',
    storageOnly,
    onRecovered: recovered => {
      store.replaceSessionEnvironment(conversationId, app.id, recovered)
      if (legacy) store.replaceSessionEnvironment(legacyKey, app.id, recovered)
      if (teamKey) store.replaceSessionEnvironment(teamKey, app.id, recovered)
    },
  }) : resolveExecutionEnvironment(app, manager, app.spaceId, 'chat', storageOnly)
  if (teamKey) store.pinSessionEnvironment(teamKey, app.id, environment)
  return store.pinSessionEnvironment(conversationId, app.id, environment)
}

/** Resolve transcript storage without requiring the user's project folder to be mounted. */
export function resolveChatRecordEnvironment(
  app: InstalledApp,
  manager: EnvironmentManager,
  store: Pick<ActivityStore, 'getSessionEnvironment' | 'pinSessionEnvironment' | 'replaceSessionEnvironment'>,
  conversationId: string,
  teamId?: string,
): ExecutionEnvironment {
  return resolveChatEnvironment(app, manager, store, conversationId, teamId, true)
}

export function validateEnvironmentConnections(
  environment: ExecutionEnvironment,
  app: InstalledApp,
  manager: Pick<AppManagerService, 'listEffectiveMcpApps'>,
  mode: 'chat' | 'automation' = 'automation',
): { changed: boolean; changedSpecIds: string[] } {
  if (!environment.spaceId) return { changed: false, changedSpecIds: [] }
  const current = connectionBindings(app, manager.listEffectiveMcpApps(environment.spaceId), mode)
  const previous = environment.mcpBindings ?? {}
  const changedSpecIds = [...new Set([...Object.keys(previous), ...Object.keys(current)])]
    .filter(specId => previous[specId] !== current[specId])
  environment.mcpBindings = current
  if (changedSpecIds.length > 0) {
    console.warn('[Runtime] Execution connections updated to current authorized instances', { appId: app.id, changedSpecIds })
  }
  return { changed: changedSpecIds.length > 0, changedSpecIds }
}

/**
 * Declared connections an independent run could not use: not installed, or
 * installed but not running. A run hands only running ones to the model, so
 * starting without them would leave it short of tools it was built around.
 * A dependency the owner switched off for this person is a choice, not a gap,
 * and built-in capabilities are not installable connections.
 */
export function missingConnections(
  app: InstalledApp,
  manager: Pick<AppManagerService, 'listEffectiveMcpApps'>,
  spaceId: string,
): MissingConnection[] {
  const declared = (app.spec.requires?.mcps ?? [])
    .filter(dependency => dependency.enabled !== false && !BUILTIN_MCP_SERVER_IDS.has(dependency.id))
  if (declared.length === 0) return []
  const installed = manager.listEffectiveMcpApps(spaceId)
  const missing: MissingConnection[] = []
  for (const dependency of declared) {
    const instances = installed.filter(resource => resource.specId === dependency.id)
    if (instances.some(resource => resource.status === 'active')) continue
    const instance = instances[0]
    missing.push({
      id: dependency.id,
      name: instance?.spec.name ?? dependency.id,
      state: !instance ? 'not_installed'
        : instance.status === 'paused' ? 'disabled'
          : instance.status === 'needs_login' ? 'needs_login'
            : 'error',
    })
  }
  return missing
}

export function legacySessionEnvironmentKey(appId: string, runId: string): string {
  return `legacy-file:${appId}:${runId}`
}

interface EnvironmentRecovery {
  app: InstalledApp
  manager: EnvironmentManager
  mode?: 'chat' | 'automation'
  storageOnly?: boolean
  onRecovered?: (environment: ExecutionEnvironment) => void
}

/** Installed people recover missing Halo storage; project folders retain their repair error. */
export function validateExecutionEnvironment(environment: ExecutionEnvironment, recovery?: EnvironmentRecovery): ExecutionEnvironment {
  recovery?.manager.assertAppDataAvailable?.(recovery.app.id)
  const space = environment.spaceId ? getSpace(environment.spaceId) : null
  if (!space) {
    if (recovery) return recoverExecutionEnvironment(environment, recovery)
    throw new Error('The original work space is unavailable. Restore it before continuing.')
  }
  const storageAvailable = isDirectory(environment.spacePath) && isDirectory(environment.memoryDir)
  if (!storageAvailable && recovery) return recoverExecutionEnvironment(environment, recovery)
  if (!isDirectory(environment.workDir)) {
    console.warn(`[Runtime] Working directory does not exist: "${environment.workDir}" (space ${environment.spaceId})`)
    throw new WorkingDirectoryUnavailableError(environment.workDir, environment.spaceId!)
  }
  if (!storageAvailable) {
    throw new Error('The original history or memory is unavailable. Restore it before continuing.')
  }
  return environment
}

function validateEnvironmentStorage(environment: ExecutionEnvironment, recovery?: EnvironmentRecovery): ExecutionEnvironment {
  recovery?.manager.assertAppDataAvailable?.(recovery.app.id)
  if (!environment.spaceId || !getSpace(environment.spaceId) || !isDirectory(environment.spacePath) || !isDirectory(environment.memoryDir)) {
    if (recovery) return recoverExecutionEnvironment(environment, recovery)
    throw new Error('The original history or memory is unavailable. Restore it before continuing.')
  }
  return environment
}

function recoverExecutionEnvironment(previous: ExecutionEnvironment, recovery: EnvironmentRecovery): ExecutionEnvironment {
  const environment = resolveExecutionEnvironment(recovery.app, recovery.manager, recovery.app.spaceId, recovery.mode, recovery.storageOnly)
  const workspace = previous.pendingWorkspaceNotice ?? (previous.spacePath !== environment.spacePath ? { kind: 'missing' as const } : undefined)
  if (workspace) environment.pendingWorkspaceNotice = workspace
  recovery.onRecovered?.(environment)
  console.warn('[Runtime] Missing execution environment reconnected to current workspace', {
    appId: recovery.app.id, previousSpaceId: previous.spaceId, spaceId: environment.spaceId,
  })
  return environment
}

function isDirectory(path: string | undefined): boolean {
  if (!path) return false
  try {
    return statSync(path).isDirectory()
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
    throw error
  }
}

export function getLegacyAppDataPath(app: InstalledApp): string | undefined {
  if (app.dataPath) return app.dataPath
  const space = app.spaceId ? getSpace(app.spaceId) : null
  return space ? join(space.path, '.halo', 'apps', app.id) : undefined
}
