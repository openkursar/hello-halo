import { basename, dirname, join, relative, resolve } from 'path'
import { isPathWithin, physicalPath } from '../../../foundation/path-containment'
import { getTeamService, getTeamStore, type ParticipantExecution, type ParticipantMaintenance, type TeamStore } from '../../team'
import type { ExecutionEnvironment } from '../../../../shared/apps/app-types'
import { appChatAppId, parseRunSenderKey } from '../../../../shared/apps/im-keys'

function sourceOwnerAppId(source: string): string | null {
  return appChatAppId(source) ?? parseRunSenderKey(source)?.appId ?? null
}

export interface ParticipantRelocation {
  sourcePath: string
  targetPath: string
}

export interface TeamWorkspaceChangeInput {
  appId: string
  sourceSpaceId: string | null
  sourceWorkDirs?: readonly string[]
  targetEnvironment: ExecutionEnvironment
  targetAppRoot: string
  deletingSpacePath?: string
}

export interface TeamWorkspaceChangePlan {
  actorIds: readonly string[]
  relocations: ParticipantRelocation[]
  environments: Array<{ appId: string; environment: ExecutionEnvironment; previousEnvironment: ExecutionEnvironment }>
  /** These actors lost their old working directory or repository; use neutral history, not a native resume. */
  resetSessionActorIds: readonly string[]
  /** Run inside the caller's database transaction after filesystem staging succeeds. */
  commitEnvironment(): void
}

export interface TeamWorkspaceChange {
  readonly actorIds: readonly string[]
  /** Allocation cancellation only; caller must also stop and drain all returned execution actors. */
  drain(): Promise<TeamWorkspaceChangePlan>
  release(): void
}

function contains(root: string, path: string): boolean {
  return isPathWithin(path, root)
}

function relativePath(root: string, path: string): string {
  return relative(physicalPath(root), physicalPath(path))
}

function relocateExecution(execution: ParticipantExecution, metadata: ParticipantRelocation, input: TeamWorkspaceChangeInput
): { execution: ParticipantExecution; resetSession: boolean } {
  const target = input.targetEnvironment
  const map = (path: string) => contains(metadata.sourcePath, path)
    ? join(metadata.targetPath, relativePath(metadata.sourcePath, path)) : path
  const deleted = (path: string) => !!input.deletingSpacePath && contains(input.deletingSpacePath, map(path))
  const resetSession = [execution.environment.workDir, execution.workspace?.cwd, execution.workspace?.gitRoot,
    execution.workspace?.gitCommonDirectory, execution.workspace?.checkout].some(path => path && deleted(path))
  const { workspace, ...retained } = execution
  const insideSourceData = contains(execution.environment.spacePath, execution.environment.workDir)
  const rerootDirectory = !workspace?.checkout && insideSourceData && !contains(metadata.sourcePath, execution.environment.workDir)
  const sourceRoot = (input.sourceWorkDirs ?? []).filter(path => contains(execution.environment.spacePath, path)
    && contains(path, execution.environment.workDir)).sort((left, right) => right.length - left.length)[0] ?? execution.environment.spacePath
  const workDir = resetSession ? target.workDir : rerootDirectory
    ? join(target.workDir, relativePath(sourceRoot, execution.environment.workDir)) : map(execution.environment.workDir)
  const mapWorkingRoot = (path: string) => contains(metadata.sourcePath, path) ? map(path)
    : rerootDirectory && contains(execution.environment.workDir, path)
      ? join(workDir, relativePath(execution.environment.workDir, path)) : path
  const access = execution.fileAccess
  return {
    resetSession,
    execution: {
      ...retained,
      environment: { ...target, workDir, memoryDir: metadata.targetPath },
      ...(resetSession ? { stopped: true } : {}),
      ...(workspace && !resetSession ? { workspace: { ...workspace, cwd: mapWorkingRoot(workspace.cwd),
        ...(workspace.gitRoot ? { gitRoot: map(workspace.gitRoot) } : {}),
        ...(workspace.gitCommonDirectory ? { gitCommonDirectory: map(workspace.gitCommonDirectory) } : {}),
        ...(workspace.checkout ? { checkout: map(workspace.checkout) } : {}) } } : {}),
      ...(access ? { fileAccess: { ...access, cwd: resetSession ? workDir : mapWorkingRoot(access.cwd),
        memoryWritable: access.memoryWritable.filter(path => !deleted(path)).map(map),
        memoryReadable: access.memoryReadable.filter(path => !deleted(path)).map(map),
        attachedFiles: access.attachedFiles.filter(path => !deleted(path)).map(map),
        workspaceRoots: resetSession ? [workDir] : access.workspaceRoots.map(mapWorkingRoot),
        closed: access.closed.map(map), hookGuarded: access.hookGuarded.map(map),
        memorySystemPaths: access.memorySystemPaths.map(map),
        ...(access.skillFolders ? { skillFolders: access.skillFolders.filter(path => !deleted(path)).map(map) } : {}),
        ...(access.engineConfigDirs ? { engineConfigDirs: access.engineConfigDirs.map(map) } : {}) } } : {}),
    },
  }
}

/** Store-only planning for startup repair, before any local execution can be admitted. No runtime or filesystem effects. */
export function prepareTeamWorkspaceChange(input: TeamWorkspaceChangeInput, store: TeamStore): TeamWorkspaceChangePlan {
  const actors = new Set([input.appId])
  const local = store.participants.listLocalExecutions()
  const allTeams = store.listTeams()
  const sources = new Map(allTeams.map(team => [team.id, team.coordinatorConversationId]))
  let changed = true
  while (changed) {
    changed = false
    for (const { participant, execution } of local) {
      if (actors.has(participant.appId) || actors.has(participant.parentAppId)
        || (!!execution.sourceAppId && actors.has(execution.sourceAppId))
        || actors.has(sourceOwnerAppId(sources.get(participant.teamId) ?? '') ?? '')) {
        if (!actors.has(participant.appId)) { actors.add(participant.appId); changed = true }
      }
    }
  }
  const relocations: ParticipantRelocation[] = []
  const updates = local.filter(row => actors.has(row.participant.appId)).map(({ participant, execution }) => {
    if (basename(execution.environment.memoryDir) !== participant.appId
      || basename(dirname(execution.environment.memoryDir)) !== 'collaboration') {
      throw new Error('The collaborator metadata location is not recognized. Its files were retained for inspection.')
    }
    const metadata = { sourcePath: execution.environment.memoryDir,
      targetPath: join(input.targetAppRoot, 'collaboration', participant.appId) }
    if (resolve(metadata.sourcePath) !== resolve(metadata.targetPath)) relocations.push(metadata)
    const transcript = { sourcePath: join(execution.environment.spacePath, '.halo', 'apps', participant.appId),
      targetPath: join(input.targetEnvironment.spacePath, '.halo', 'apps', participant.appId) }
    if (resolve(transcript.sourcePath) !== resolve(transcript.targetPath)) relocations.push(transcript)
    return { participant, previousEnvironment: execution.environment, ...relocateExecution(execution, metadata, input) }
  })
  const teams = allTeams.filter(team => team.ephemeral && team.coordinatorConversationId
    && actors.has(sourceOwnerAppId(team.coordinatorConversationId) ?? '') && team.owningSpaceId === input.sourceSpaceId)
  return {
    actorIds: [...actors], relocations,
    environments: updates.map(({ participant, execution, previousEnvironment }) => ({ appId: participant.appId, environment: execution.environment, previousEnvironment })),
    resetSessionActorIds: updates.filter(update => update.resetSession).map(update => update.participant.appId),
    commitEnvironment() {
      for (const { participant, execution } of updates) {
        store.participants.updateExecution(participant.teamId, participant.epochId, participant.appId, execution)
      }
      if (input.targetEnvironment.spaceId) for (const team of teams) {
        store.updateTeamFields(team.id, { owningSpaceId: input.targetEnvironment.spaceId })
      }
    },
  }
}

/** Local-only maintenance: never seals an epoch or changes another owner's execution. */
export function beginTeamWorkspaceChange(input: TeamWorkspaceChangeInput,
  dependencies?: { store: TeamStore; participants: Pick<import('../../team').ParticipantService, 'beginMaintenance'> }): TeamWorkspaceChange {
  const store = dependencies?.store ?? getTeamStore()
  const participants = dependencies?.participants ?? getTeamService()?.participants
  if (!store || !participants) throw new Error('Collaboration services are unavailable for workspace maintenance.')
  const sources = store.listTeams().filter(team => team.ephemeral && team.coordinatorConversationId
    && sourceOwnerAppId(team.coordinatorConversationId) === input.appId).map(team => team.coordinatorConversationId!)
  const lease: ParticipantMaintenance = participants.beginMaintenance({ appIds: [input.appId], sourceConversationIds: sources })
  console.log(`[TeamWorkspaceChange] Fenced local work: app=${input.appId} actors=${lease.actorIds.length}`)
  let plan: Promise<TeamWorkspaceChangePlan> | undefined
  return {
    get actorIds() { return lease.actorIds },
    release: () => lease.release(),
    drain() {
      return plan ??= (async () => {
        await lease.drain()
        const prepared = prepareTeamWorkspaceChange(input, store)
        console.log(`[TeamWorkspaceChange] Local allocations drained: app=${input.appId} participants=${prepared.environments.length} relocations=${prepared.relocations.length}`)
        return prepared
      })()
    },
  }
}
