/** Digital Team IPC handlers. Thin delegation to TeamService. */

import { ipcMain } from 'electron'
import { getTeamService } from '../apps/team'
import { getAppManager } from '../apps/manager'
import { TEAM_IPC } from '../../shared/apps/team-types'
import { buildTeamSessionKey } from '../../shared/apps/im-keys'
import { deriveRunId } from '../apps/runtime/app-chat'
import { readSessionMessages } from '../apps/runtime/session-store'
import { getSpace } from '../services/space.service'
import type { TeamService } from '../apps/team'
import type {
  CreateTeamInput,
  UpdateTeamInput,
  TeamMemberInput,
  TeamEdge,
  ProposedMember,
  TeamRunTrigger,
  TeamTriggerInput,
} from '../../shared/apps/team-types'

type Envelope<T = unknown> = { success: true; data?: T } | { success: false; error: string }

function requireService(): { ok: true; service: TeamService } | { ok: false; error: string } {
  const service = getTeamService()
  if (!service) {
    return { ok: false, error: 'Team service is not yet initialized. Please try again shortly.' }
  }
  return { ok: true, service }
}

/** Wrap a service call in the standard envelope with logging. */
async function handle<T>(label: string, fn: (service: TeamService) => Promise<T> | T): Promise<Envelope<T>> {
  const r = requireService()
  if (!r.ok) return { success: false, error: r.error }
  try {
    const data = await fn(r.service)
    return { success: true, data }
  } catch (error) {
    const err = error as Error
    console.error(`[TeamIPC] ${label} error:`, err.message)
    return { success: false, error: err.message }
  }
}

export function registerTeamIpc(): void {
  ipcMain.handle(TEAM_IPC.list, async (_e, spaceId?: string) =>
    handle('team:list', (s) => s.listTeamItems(spaceId))
  )

  ipcMain.handle(TEAM_IPC.get, async (_e, teamId: string) =>
    handle('team:get', (s) => s.getTeam(teamId))
  )

  ipcMain.handle(
    TEAM_IPC.create,
    async (_e, input: { input: CreateTeamInput; confirmedProposal?: ProposedMember[] }) =>
      handle('team:create', (s) => s.createTeam(input.input, input.confirmedProposal))
  )

  ipcMain.handle(
    TEAM_IPC.update,
    async (_e, input: { teamId: string; input: UpdateTeamInput }) =>
      handle('team:update', (s) => s.updateTeam(input.teamId, input.input))
  )

  ipcMain.handle(TEAM_IPC.dissolve, async (_e, teamId: string) =>
    handle('team:dissolve', (s) => s.dissolveTeam(teamId))
  )

  ipcMain.handle(
    TEAM_IPC.addMember,
    async (_e, input: { teamId: string; member: TeamMemberInput }) =>
      handle('team:add-member', (s) => s.addMember(input.teamId, input.member))
  )

  ipcMain.handle(
    TEAM_IPC.removeMember,
    async (_e, input: { teamId: string; appId: string }) =>
      handle('team:remove-member', (s) => s.removeMember(input.teamId, input.appId))
  )

  ipcMain.handle(
    TEAM_IPC.setEdges,
    async (_e, input: { teamId: string; edges: TeamEdge[] }) =>
      handle('team:set-edges', (s) => s.setEdges(input.teamId, input.edges))
  )

  ipcMain.handle(
    TEAM_IPC.proposeMembers,
    async (_e, input: { goal: string; owningSpaceId: string }) =>
      handle('team:propose-members', (s) => s.proposeMembers(input.goal, input.owningSpaceId))
  )

  ipcMain.handle(TEAM_IPC.run, async (_e, teamId: string, trigger?: TeamRunTrigger) =>
    handle('team:run', (s) => s.runTeam(teamId, trigger ?? { type: 'manual' }))
  )

  ipcMain.handle(TEAM_IPC.pause, async (_e, teamId: string) =>
    handle('team:pause', (s) => s.pauseTeam(teamId))
  )

  ipcMain.handle(TEAM_IPC.getDetail, async (_e, teamId: string) =>
    handle('team:get-detail', (s) => s.getTeamDetail(teamId))
  )

  ipcMain.handle(TEAM_IPC.listArtifacts, async (_e, teamId: string) =>
    handle('team:list-artifacts', (s) => s.listArtifacts(teamId))
  )

  // ── team:chat-messages — a member's team-channel chat history for ONE run ──
  ipcMain.handle('team:chat-messages', async (_e, input: { appId: string; spaceId?: string; teamId: string; epochId: string }) => {
    try {
      // Resolve the member's space from the app itself — the renderer roster does
      // not always carry a spaceId (the blackboard roster leaves it null), and a
      // missing/empty spaceId is exactly what made history appear "lost" after a
      // turn ended. The app's installed spaceId is authoritative.
      const appSpaceId = getAppManager()?.getApp(input.appId)?.spaceId ?? input.spaceId ?? null
      if (!appSpaceId) return { success: true, data: [] }
      const space = getSpace(appSpaceId)
      if (!space?.path) return { success: true, data: [] }
      const conversationId = buildTeamSessionKey(input.appId, input.teamId, input.epochId)
      const runId = deriveRunId(conversationId, input.appId)
      const messages = readSessionMessages(space.path, input.appId, runId)
      return { success: true, data: messages }
    } catch (err) {
      const e = err as Error
      console.error('[TeamIPC] team:chat-messages error:', e.message)
      return { success: false, error: e.message }
    }
  })

  // ── team:list-epochs — run history (newest first) ─────────────────────────
  ipcMain.handle('team:list-epochs', async (_e, teamId: string) =>
    handle('team:list-epochs', (s) => s.listEpochs(teamId))
  )

  // ── team:epoch-board — tasks/findings/roster snapshot for a past run ──────
  ipcMain.handle('team:epoch-board', async (_e, input: { teamId: string; epochId: string }) =>
    handle('team:epoch-board', (s) => s.getEpochBoard(input.teamId, input.epochId))
  )

  // ── team:epoch-artifacts — products produced during a specific run ────────
  ipcMain.handle('team:epoch-artifacts', async (_e, input: { teamId: string; epochId: string }) =>
    handle('team:epoch-artifacts', (s) => s.listArtifacts(input.teamId, input.epochId))
  )

  // ── triggers (team as a first-class triggerable entity) ───────────────────
  ipcMain.handle(TEAM_IPC.listTriggers, async (_e, teamId: string) =>
    handle('team:list-triggers', (s) => s.listTriggers(teamId))
  )

  ipcMain.handle(
    TEAM_IPC.setTrigger,
    async (_e, input: { teamId: string; trigger: TeamTriggerInput; triggerId?: string }) =>
      handle('team:set-trigger', (s) => s.setTrigger(input.teamId, input.trigger, input.triggerId))
  )

  ipcMain.handle(
    TEAM_IPC.removeTrigger,
    async (_e, input: { teamId: string; triggerId: string }) =>
      handle('team:remove-trigger', (s) => s.removeTrigger(input.teamId, input.triggerId))
  )

  console.log('[TeamIPC] Team handlers registered (20 channels)')
}
