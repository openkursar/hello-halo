import type { AppManagerService, InstalledApp } from '../manager'
import type { SpaceDeletionImpact } from '../../../shared/types/space'
import { isPathWithin } from '../../foundation/path-containment'
import { getSpace, getHaloSpace, getSpaceMemoryLayout } from '../../services/space.service'
import { beginSpaceMaintenance, countSpaceWorkspaceWork } from '../../services/agent'
import { suspendMemoryConsolidation } from '../../services/memory-consolidation'
import type { ActivityStore } from './store'
import type { AppRuntimeService } from './types'
import { countAppChats } from './app-chat'
import { relocateAppWorkspace } from './space-change'
import { mutateWorkspace } from './workspace-mutations'
import { acquireAppWorkspaceChange, awaitWorkspaceDrain } from './workspace-admission'
import { getTeamService, getTeamStore } from '../team'
import { stopAndDrainAppChats } from './app-chat'
import { TEAM_EVENTS } from '../../../shared/apps/team-types'
import { sendToRenderer } from '../../foundation/window.service'
import { broadcastToAll } from '../../http/websocket'

interface WorkspaceDeletionDependencies {
  manager: AppManagerService
  store: ActivityStore
  runtime: AppRuntimeService
}

async function closeWorkspaceCollaborations(spaceId: string): Promise<() => void> {
  const store = getTeamStore()
  const service = getTeamService()
  if (!store || !service) return () => {}
  const teams = store.listTeamsBySpace(spaceId)
  const temporary = teams.filter(team => team.ephemeral && team.coordinatorConversationId)
  const lease = service.participants.beginMaintenance({ sourceConversationIds: temporary.map(team => team.coordinatorConversationId!) })
  let releaseActors: (() => void) | undefined
  try {
    await awaitWorkspaceDrain(spaceId, 'collaborator allocations', lease.drain())
    releaseActors = await acquireAppWorkspaceChange(lease.actorIds)
    await Promise.all(lease.actorIds.map(stopAndDrainAppChats))
    for (const team of temporary) await service.dissolveTeam(team.id, { preserveInstalledMembers: true })
    const fallback = getHaloSpace().id
    for (const team of teams.filter(team => !team.ephemeral)) {
      store.updateTeamFields(team.id, { owningSpaceId: fallback })
      const payload = { teamId: team.id, team: store.getTeamById(team.id) }
      sendToRenderer(TEAM_EVENTS.updated, payload)
      broadcastToAll(TEAM_EVENTS.updated, payload)
    }
    return () => { releaseActors?.(); lease.release() }
  } catch (error) {
    releaseActors?.()
    lease.release()
    throw error
  }
}

function affectedPeople(deps: WorkspaceDeletionDependencies, spaceId: string): InstalledApp[] {
  const space = getSpace(spaceId)
  if (!space) return []
  const pinned = new Set(deps.store.listAppIdsPinnedInSpace(spaceId))
  return deps.manager.listApps({ type: 'automation' }).filter(app => {
    if (app.spaceId === spaceId || pinned.has(app.id) || !!app.dataPath && isPathWithin(app.dataPath, space.path)) return true
    const current = app.spaceId ? getSpace(app.spaceId) : null
    return !!current && isPathWithin(current.path, space.path)
  })
}

/** Explicit deletion preview only; ordinary workspace reads never enumerate people or work. */
export function previewWorkspaceDeletion(deps: WorkspaceDeletionDependencies, spaceId: string): SpaceDeletionImpact {
  const people = affectedPeople(deps, spaceId)
  const digitalHumans = people.filter(app => app.spaceId === spaceId).map(app => ({ id: app.id, name: app.spec.name }))
  const appRuns = people.reduce((count, app) => count + deps.runtime.getAppWorkspaceWorkCount(app.id), 0)
  const activeChats = people.reduce((count, app) => count + countAppChats(app.id), 0)
  return { digitalHumans, activeWorkCount: appRuns + activeChats + countSpaceWorkspaceWork(spaceId, { ordinaryOnly: true }) }
}

/** The supplied removal runs only after every digital human is independent of the old space. */
export function deleteWorkspacePreservingPeople(
  deps: WorkspaceDeletionDependencies,
  spaceId: string,
  remove: () => Promise<boolean>,
): Promise<boolean> {
  return mutateWorkspace(async () => {
    const space = getSpace(spaceId)
    if (!space || space.isTemp) return false
    const maintenance = beginSpaceMaintenance(spaceId)
    const releaseInstallations = deps.manager.holdWorkspaceData([], spaceId)
    const spaceMemory = getSpaceMemoryLayout(spaceId)
    const memory = suspendMemoryConsolidation(spaceMemory ? [spaceMemory] : [])
    let releaseCollaborations: (() => void) | undefined
    try {
      for (const app of affectedPeople(deps, spaceId)) {
        const destination = app.spaceId && app.spaceId !== spaceId && getSpace(app.spaceId) ? app.spaceId : getHaloSpace().id
        await relocateAppWorkspace(deps, app.id, destination, space.path)
      }
      releaseCollaborations = await closeWorkspaceCollaborations(spaceId)
      await maintenance.stopAndDrain()
      await awaitWorkspaceDrain(spaceId, 'memory consolidation', memory.drain())
      for (const app of affectedPeople(deps, spaceId)) {
        console.error('[Runtime] Workspace deletion still has digital human dependencies', { spaceId, appId: app.id })
        throw new Error('A digital human still depends on this workspace. Its data was retained; retry the deletion.')
      }
      const removed = await remove()
      if (removed) console.log('[Runtime] Workspace deleted after digital humans were preserved', { spaceId })
      return removed
    } finally {
      memory.release()
      releaseCollaborations?.()
      maintenance.release()
      releaseInstallations()
    }
  })
}
