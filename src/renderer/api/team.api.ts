/** Digital Team domain slice of the unified api object. */
import { httpRequest, isElectron, onEvent } from './_shared'
import type { ApiResponse } from './_shared'
import type {
  CreateTeamInput,
  UpdateTeamInput,
  TeamMemberInput,
  TeamEdge,
  ProposedMember,
  TeamTriggerInput,
} from '../../shared/apps/team-types'

export const teamApi = {
  // ===== Teams =====
  teamList: async (spaceId?: string): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.teamList(spaceId)
    const qs = spaceId ? `?spaceId=${encodeURIComponent(spaceId)}` : ''
    return httpRequest('GET', `/api/teams${qs}`)
  },

  teamGet: async (teamId: string): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.teamGet(teamId)
    return httpRequest('GET', `/api/teams/${teamId}`)
  },

  teamGetDetail: async (teamId: string): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.teamGetDetail(teamId)
    return httpRequest('GET', `/api/teams/${teamId}/detail`)
  },

  teamListArtifacts: async (teamId: string): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.teamListArtifacts(teamId)
    return httpRequest('GET', `/api/teams/${teamId}/artifacts`)
  },

  /** Load a member's team-channel chat history for one run (the work they did). */
  teamChatMessages: async (appId: string, spaceId: string, teamId: string, epochId: string): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.teamChatMessages({ appId, spaceId, teamId, epochId })
    return httpRequest('GET', `/api/teams/${teamId}/chat-messages?appId=${encodeURIComponent(appId)}&epochId=${encodeURIComponent(epochId)}`)
  },

  /**
   * Send a message to a member that runs on someone else's machine. Routes
   * through the office's owner (team wake) rather than local app-chat, which
   * cannot resolve a non-local app. The owner runs the turn and relays the
   * stream + result back. Desktop-only (needs the federation connection).
   */
  teamSendToMember: async (input: {
    teamId: string
    appId: string
    epochId: string
    message: string
    images?: { type: string; media_type: string; data: string }[]
    thinkingEnabled?: boolean
  }): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.teamSendToMember(input)
    return httpRequest('POST', `/api/teams/${input.teamId}/members/${input.appId}/send`, {
      epochId: input.epochId,
      message: input.message,
      images: input.images,
      thinkingEnabled: input.thinkingEnabled,
    })
  },

  /** Run history (epochs), newest first. */
  teamListEpochs: async (teamId: string): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.teamListEpochs(teamId)
    return httpRequest('GET', `/api/teams/${teamId}/epochs`)
  },

  /** Tasks/findings/members snapshot for one past run. */
  teamEpochBoard: async (teamId: string, epochId: string): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.teamEpochBoard({ teamId, epochId })
    return httpRequest('GET', `/api/teams/${teamId}/epochs/${epochId}/board`)
  },

  /** Products produced during one specific run. */
  teamEpochArtifacts: async (teamId: string, epochId: string): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.teamEpochArtifacts({ teamId, epochId })
    return httpRequest('GET', `/api/teams/${teamId}/epochs/${epochId}/artifacts`)
  },

  teamCreate: async (input: CreateTeamInput, confirmedProposal?: ProposedMember[]): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.teamCreate({ input, confirmedProposal })
    return httpRequest('POST', '/api/teams', { input, confirmedProposal })
  },

  teamUpdate: async (teamId: string, input: UpdateTeamInput): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.teamUpdate({ teamId, input })
    return httpRequest('PATCH', `/api/teams/${teamId}`, input as Record<string, unknown>)
  },

  teamDissolve: async (teamId: string): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.teamDissolve(teamId)
    return httpRequest('DELETE', `/api/teams/${teamId}`)
  },

  teamAddMember: async (teamId: string, member: TeamMemberInput): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.teamAddMember({ teamId, member })
    return httpRequest('POST', `/api/teams/${teamId}/members`, member as unknown as Record<string, unknown>)
  },

  teamRemoveMember: async (teamId: string, appId: string): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.teamRemoveMember({ teamId, appId })
    return httpRequest('DELETE', `/api/teams/${teamId}/members/${appId}`)
  },

  teamSetEdges: async (teamId: string, edges: TeamEdge[]): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.teamSetEdges({ teamId, edges })
    return httpRequest('PUT', `/api/teams/${teamId}/edges`, { edges })
  },

  teamProposeMembers: async (goal: string, owningSpaceId: string): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.teamProposeMembers({ goal, owningSpaceId })
    return httpRequest('POST', '/api/teams/propose-members', { goal, owningSpaceId })
  },

  teamRun: async (teamId: string): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.teamRun(teamId)
    return httpRequest('POST', `/api/teams/${teamId}/run`)
  },

  teamPause: async (teamId: string): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.teamPause(teamId)
    return httpRequest('POST', `/api/teams/${teamId}/pause`)
  },

  // ===== Remote office: invite / join =====
  /**
   * Mint an invite link for a team's office (host). Control-plane over HTTP. An
   * optional scope narrows what the joiner may see/contact/be-assigned (omitted =
   * default-open). The scope shape is inlined because OfficeScope lives in main.
   */
  teamGenerateInvite: async (
    teamId: string,
    ttlMs?: number,
    scope?: {
      visibility: 'full' | 'assigned' | 'readonly'
      contactable: 'all' | 'lead-only'
      discoverable: boolean
      canReinvite: boolean
    },
  ): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.teamGenerateInvite({ teamId, ttlMs, scope })
    const body: { ttlMs?: number; scope?: typeof scope } = {}
    if (ttlMs !== undefined) body.ttlMs = ttlMs
    if (scope !== undefined) body.scope = scope
    return httpRequest('POST', `/api/teams/${teamId}/invite`, body)
  },

  /** Revoke a previously issued invite by its jti. Control-plane over HTTP. */
  teamRevokeInvite: async (teamId: string, jti: string): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.teamRevokeInvite({ jti })
    return httpRequest('DELETE', `/api/teams/${teamId}/invite/${encodeURIComponent(jti)}`)
  },

  /**
   * Join an office hosted elsewhere, bringing local digital humans (joiner).
   * Desktop-only: it needs local apps and an outbound federation connection.
   */
  teamJoinOffice: async (input: {
    officeId: string
    serverUrl: string
    inviteToken: string
    bringAppIds: string[]
  }): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.teamJoinOffice(input)
    return { success: false, error: 'DESKTOP_ONLY' }
  },

  /** Leave a joined office, removing this node's local shadow of it (joiner). */
  teamLeaveOffice: async (officeId: string): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.teamLeaveOffice({ officeId })
    return { success: false, error: 'DESKTOP_ONLY' }
  },

  /**
   * One-shot pull of an office-invite link that arrived via a halo:// deep link
   * before the renderer was ready (cold start from a browser click). Desktop
   * only — web clients are never a deep-link target.
   */
  teamConsumePendingInvite: async (): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.teamConsumePendingInvite()
    return { success: true, data: null }
  },

  // ===== Triggers (schedule / etc.) =====
  teamListTriggers: async (teamId: string): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.teamListTriggers(teamId)
    return httpRequest('GET', `/api/teams/${teamId}/triggers`)
  },

  teamSetTrigger: async (teamId: string, trigger: TeamTriggerInput, triggerId?: string): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.teamSetTrigger({ teamId, trigger, triggerId })
    return httpRequest('POST', `/api/teams/${teamId}/triggers`, { trigger, triggerId })
  },

  teamRemoveTrigger: async (teamId: string, triggerId: string): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.teamRemoveTrigger({ teamId, triggerId })
    return httpRequest('DELETE', `/api/teams/${teamId}/triggers/${triggerId}`)
  },

  // ===== Team Event Listeners =====
  onTeamUpdated: (callback: (data: unknown) => void) => onEvent('team:updated', callback),
  onTeamBlackboard: (callback: (data: unknown) => void) => onEvent('team:blackboard', callback),
  onTeamMessage: (callback: (data: unknown) => void) => onEvent('team:message', callback),
  onTeamPresence: (callback: (data: unknown) => void) => onEvent('team:presence', callback),
  onTeamOfficeStatus: (callback: (data: unknown) => void) => onEvent('team:office-status', callback),
  onTeamInviteLink: (callback: (data: unknown) => void) => onEvent('team:invite-link', callback),
}
