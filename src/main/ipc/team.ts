/** Digital Team IPC handlers. Thin delegation to TeamService. */

import { ipcMain } from 'electron'
import { getTeamService } from '../apps/team'
import { TEAM_IPC, memberChatKey } from '../../shared/apps/team-types'
import { readTeamMemberMessages } from '../apps/runtime/app-chat'
import { getTeamStore } from '../apps/team'
import { getFederationManager } from '../apps/runtime/federation/manager'
import { generateTeamInvite, revokeTeamInvite, joinTeamOffice, leaveTeamOffice } from '../controllers/team-invite.controller'
import type { TeamService } from '../apps/team'
import type { OfficeScope } from '../apps/federation/index'
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
  // The read logic lives in readTeamMemberMessages (apps/runtime/app-chat) so the
  // IPC and HTTP surfaces share a single source of truth. spaceId is accepted for
  // wire compatibility but ignored — the app's installed spaceId is authoritative.
  ipcMain.handle('team:chat-messages', async (_e, input: { appId: string; spaceId?: string; teamId: string; epochId: string; sinceSeq?: number }) => {
    try {
      // A remote-owned member's transcript lives on the node that OWNS it, not
      // here. Mirror the HTTP route (team.routes.ts) and pull it over the office
      // link from that owner; a locally-owned member reads from local chat
      // storage as before. Without this branch a desktop joiner refreshing a
      // remote member's history sees blank.
      // Accept only a positive integer cursor (mirror the HTTP route); anything
      // else means "full transcript" rather than trusting a bogus wire value.
      const sinceSeq =
        Number.isInteger(input.sinceSeq) && (input.sinceSeq as number) > 0 ? input.sinceSeq : undefined
      const teamStore = getTeamStore()
      const target = teamStore?.listMembersByTeam(input.teamId).find((m) => m.appId === input.appId)
      if (target?.origin === 'remote' && target.ownerNodeId) {
        const manager = getFederationManager()
        if (!manager) {
          return { success: false, error: 'Federation is not yet initialized. Please try again shortly.' }
        }
        // Resolve the SAME epoch the send path uses so a message and its transcript
        // never diverge: an open run epoch, else the member's long-lived conversation
        // epoch. Read-only — never CREATE one here (that is the send path's job); if
        // none exists yet (nothing sent), there is simply nothing to show.
        const epochId =
          input.epochId ||
          teamStore?.getCurrentEpochForTeam(input.teamId)?.id ||
          teamStore?.getOpenConversationEpoch(input.teamId, memberChatKey(input.appId))?.id
        if (!epochId) return { success: true, data: [] }
        const result = await manager.fetchMemberHistory({
          officeId: input.teamId,
          ownerNodeId: target.ownerNodeId,
          appId: input.appId,
          epochId,
          sinceSeq,
        })
        // stale=true → served from cache because the owner is unreachable; the
        // renderer shows an "offline, may not be up to date" notice.
        return { success: true, data: result.messages, stale: result.stale }
      }
      // Locally-owned member: its transcript is per-epoch on disk. No epoch yet
      // means nothing has run for it here → empty (never an error).
      if (!input.epochId) return { success: true, data: [] }
      // A local JSONL read is already fast, so return the full transcript regardless
      // of sinceSeq — the renderer dedups by seq, so re-sending known rows is harmless
      // and avoids a second read path.
      const messages = readTeamMemberMessages(input.appId, input.teamId, input.epochId)
      return { success: true, data: messages }
    } catch (err) {
      const e = err as Error
      console.error('[TeamIPC] team:chat-messages error:', e.message)
      return { success: false, error: e.message }
    }
  })

  // ── team:send-to-member — dispatch a message to one member for ONE run ────
  // Host-operator surface (the local owner driving a member directly), so no
  // per-invite scope gate here — that gate is the remote HTTP boundary's job.
  // The service routes to a remote-owned target over the office link internally;
  // epoch is resolved from the teamSessionKey when omitted.
  ipcMain.handle(
    TEAM_IPC.sendToMember,
    async (
      _e,
      input: {
        teamId: string
        appId: string
        epochId: string
        message: string
        images?: { type: string; media_type: string; data: string }[]
        thinkingEnabled?: boolean
      }
    ) => handle('team:send-to-member', (s) => s.sendToMember(input))
  )

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

  // ── Remote office: invite generation (host) ───────────────────────────────
  // Thin delegation to the shared controller so the IPC and HTTP surfaces mint
  // the same invite. Errors are internal codes the renderer maps to neutral text.
  ipcMain.handle(TEAM_IPC.generateInvite, async (_e, input: { teamId: string; ttlMs?: number; scope?: OfficeScope }) => {
    try {
      return await generateTeamInvite(input.teamId, input.ttlMs, input.scope)
    } catch (err) {
      const e = err as Error
      console.error('[TeamIPC] team:generate-invite error:', e.message)
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle(TEAM_IPC.revokeInvite, async (_e, input: { jti: string }) => {
    try {
      return revokeTeamInvite(input.jti)
    } catch (err) {
      const e = err as Error
      console.error('[TeamIPC] team:revoke-invite error:', e.message)
      return { success: false, error: e.message }
    }
  })

  // ── Remote office: join an office hosted elsewhere (joiner) ────────────────
  ipcMain.handle(
    TEAM_IPC.joinOffice,
    async (_e, input: { officeId: string; serverUrl: string; inviteToken: string; bringAppIds: string[] }) => {
      try {
        return await joinTeamOffice(input)
      } catch (err) {
        const e = err as Error
        console.error('[TeamIPC] team:join-office error:', e.message)
        return { success: false, error: e.message }
      }
    }
  )

  // ── Remote office: leave a joined office (joiner) ─────────────────────────
  ipcMain.handle(TEAM_IPC.leaveOffice, async (_e, input: { officeId: string }) => {
    try {
      return await leaveTeamOffice(input.officeId)
    } catch (err) {
      const e = err as Error
      console.error('[TeamIPC] team:leave-office error:', e.message)
      return { success: false, error: e.message }
    }
  })

  // ── Remote office: cold-start deep-link pickup (one-shot) ─────────────────
  // A halo:// invite clicked before the renderer existed is buffered in the
  // deep-link service; the renderer pulls it once on startup.
  ipcMain.handle(TEAM_IPC.consumePendingInvite, async () => {
    const { consumePendingInviteLink } = await import('../services/deep-link.service')
    return { success: true, data: consumePendingInviteLink() }
  })

  console.log('[TeamIPC] Team handlers registered (25 channels)')
}
