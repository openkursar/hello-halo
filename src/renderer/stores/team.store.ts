/** Renderer state for the Digital Team feature. */

import { useMemo } from 'react'
import { create } from 'zustand'
import { api } from '../api'
import { useNotificationStore } from './notification.store'
import i18n from '../i18n'
import type {
  TeamListItem,
  TeamDetail,
  Team,
  TeamMember,
  TeamEdge,
  TeamMemberInput,
  UpdateTeamMemberInput,
  CreateTeamInput,
  UpdateTeamInput,
  ProposedMember,
  TeamUpdatedEvent,
  TeamBlackboardEvent,
  TeamMessageEvent,
  TeamPresenceEvent,
  TeamOfficeStatusEvent,
  TeamEpochSummary,
  EpochBoard,
  TeamConversation,
} from '../../shared/apps/team-types'
import { isRemoteMember } from '../../shared/apps/team-types'

// ── Renderer-only aggregate types ────────────────────────────────────────────

/** Animates the status-board connector line; auto-expires after FLOW_TTL_MS. */
export interface ActiveFlow {
  id: string
  fromAppId: string
  toAppId: string
  ts: number
}

/** How long a flow line stays visible after a team:message arrives (~2s). */
const FLOW_TTL_MS = 2200

/** Neutral reachability of a member, derived from its owner node's presence. */
export type MemberReachability = 'online' | 'away' | 'offline'

/** A node's live presence within one office (owner name + reachability). */
export interface NodePresence {
  displayName: string | null
  status: MemberReachability
}

/**
 * Per-member presence projection consumed by the topology / cards. Owner name is
 * an identity-only label (the person's real name) — never a node id or location.
 */
export interface MemberPresence {
  reachability: MemberReachability
  /** Owner's real name for a remote member; null for a local member. */
  ownerName: string | null
  isRemote: boolean
}

/** Map the federation FSM status onto a neutral, user-facing reachability. */
function toReachability(status: 'online' | 'suspect' | 'offline'): MemberReachability {
  return status === 'suspect' ? 'away' : status
}

/**
 * Whether an office is currently resting. A transient overlay on top of the
 * persisted run status — the office is reachable ('live') until something pauses
 * it (the person who runs it stepped away), and returns to 'live' on reconnect.
 */
export type OfficeLiveness = 'live' | 'paused'

// ── State ────────────────────────────────────────────────────────────────────

interface TeamState {
  // ── Data ─────────────────────────────────
  teams: TeamListItem[]
  currentTeamId: string | null
  detail: TeamDetail | null
  /** Transient send signals for the flow-line animation (auto-expire). */
  activeFlows: ActiveFlow[]
  /** Live presence per office: teamId → (nodeId → {displayName, reachability}). */
  presence: Map<string, Map<string, NodePresence>>
  /** Office liveness overlay: teamId → 'paused' while the office is resting. Absent = live. */
  officeLiveness: Map<string, OfficeLiveness>
  /**
   * An invite link delivered by a halo:// deep link (one-click join). Set by
   * the App-level listener; the Teams tab opens the join dialog pre-filled and
   * clears it. Distinct from any dialog state so the link survives navigation.
   */
  pendingInviteLink: string | null

  // ── Loading flags ────────────────────────
  isLoadingList: boolean
  isLoadingDetail: boolean
  isCreating: boolean
  isProposing: boolean
  error: string | null

  // ── Run history (epochs) ─────────────────
  epochs: TeamEpochSummary[]
  isLoadingEpochs: boolean

  // ── Conversations (office-shared sessions) ─
  conversations: TeamConversation[]
  isLoadingConversations: boolean
  /** Selected conversation in the Conversation tab (null = none open yet). */
  selectedConversationId: string | null

  // ── List / selection ─────────────────────
  loadTeams: (spaceId?: string) => Promise<void>
  selectTeam: (teamId: string | null) => void
  loadDetail: (teamId: string) => Promise<void>
  loadEpochs: (teamId: string) => Promise<void>
  loadEpochBoard: (teamId: string, epochId: string) => Promise<EpochBoard | null>

  // ── Conversations ────────────────────────
  loadConversations: (teamId: string) => Promise<void>
  openConversation: (teamId: string, title?: string) => Promise<string | null>
  renameConversation: (teamId: string, epochId: string, title: string | null) => Promise<boolean>
  archiveConversation: (teamId: string, epochId: string) => Promise<boolean>
  selectConversation: (epochId: string | null) => void

  // ── Create ───────────────────────────────
  proposeMembers: (goal: string, owningSpaceId: string) => Promise<ProposedMember[] | null>
  createTeam: (input: CreateTeamInput, confirmedProposal?: ProposedMember[]) => Promise<Team | null>

  // ── Management ────────────────────────────
  updateTeam: (teamId: string, input: UpdateTeamInput) => Promise<boolean>
  dissolveTeam: (teamId: string) => Promise<boolean>
  /** Leave a joined office (joiner): removes this node's local shadow of it. */
  leaveOffice: (teamId: string) => Promise<boolean>
  addMember: (teamId: string, member: TeamMemberInput) => Promise<boolean>
  /** Rewrite what one of your own members does here, and what teammates may ask of it. */
  updateMember: (teamId: string, appId: string, input: UpdateTeamMemberInput) => Promise<boolean>
  /** Stop one periodic check directly, without asking an agent to do it. */
  cancelCheck: (teamId: string, checkId: string) => Promise<boolean>
  removeMember: (teamId: string, appId: string) => Promise<boolean>
  setEdges: (teamId: string, edges: TeamEdge[]) => Promise<boolean>

  // ── Run control ──────────────────────────
  runTeam: (teamId: string) => Promise<boolean>
  pauseTeam: (teamId: string) => Promise<boolean>

  // ── Real-time Event Handlers (called from App.tsx) ──
  applyTeamUpdated: (event: TeamUpdatedEvent) => void
  applyTeamBlackboard: (event: TeamBlackboardEvent) => void
  applyTeamMessage: (event: TeamMessageEvent) => void
  applyTeamPresence: (event: TeamPresenceEvent) => void
  applyTeamOfficeStatus: (event: TeamOfficeStatusEvent) => void
  /** Stage an invite link from a halo:// deep link (null clears it). */
  setPendingInviteLink: (link: string | null) => void
  /** Remove flows older than FLOW_TTL_MS (called on a timer after each message). */
  expireFlows: () => void

  /**
   * Project a member's owner identity + reachability for the office UI. Local
   * members are always reachable (this node); a remote member maps to its owner
   * node's presence, treated as online until a frame arrives (optimistic).
   */
  getMemberPresence: (
    teamId: string,
    member: { ownerNodeId?: string; origin?: 'local' | 'remote'; ownerDisplayName?: string | null }
  ) => MemberPresence
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function notifyError(title: string, detail?: string): void {
  useNotificationStore.getState().show({
    title,
    body: detail,
    variant: 'error',
    duration: 6000,
  })
}

/**
 * Toast when someone else's machine joined this office (new remote members that
 * were not present on the previous load). Deduped by the person who brought them
 * so one teammate bringing several members is a single toast. Local members you
 * added yourself never reach here (the caller filters to remote joiners).
 */
function notifyMembersJoined(officeName: string, joined: Array<{ ownerDisplayName?: string | null }>): void {
  if (joined.length === 0) return
  const people = Array.from(
    new Set(joined.map(m => m.ownerDisplayName?.trim()).filter((n): n is string => !!n))
  )
  const who = people.length > 0 ? people.join(', ') : i18n.t('A new teammate')
  useNotificationStore.getState().show({
    title: i18n.t('New teammate joined'),
    body: i18n.t('{{who}} joined "{{office}}".', { who, office: officeName }),
    variant: 'default',
    duration: 6000,
  })
}

/** Sort: waiting-for-decision first, then running, then most-recent activity. */
function sortTeams(teams: TeamListItem[]): TeamListItem[] {
  const rank = (t: TeamListItem): number => {
    // hasWaitingUser alone: it already means "a decision is waiting on YOU",
    // whereas a joined office's status mirrors the host and can announce a
    // decision someone else owes.
    if (t.hasWaitingUser) return 0
    if (t.status === 'running') return 1
    return 2
  }
  return [...teams].sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    return b.updatedAt - a.updatedAt
  })
}
// ── Store ────────────────────────────────────────────────────────────────────

export const useTeamStore = create<TeamState>((set, get) => ({
  teams: [],
  currentTeamId: null,
  detail: null,
  activeFlows: [],
  presence: new Map(),
  officeLiveness: new Map(),
  pendingInviteLink: null,
  epochs: [],
  isLoadingEpochs: false,
  conversations: [],
  isLoadingConversations: false,
  selectedConversationId: null,

  isLoadingList: false,
  isLoadingDetail: false,
  isCreating: false,
  isProposing: false,
  error: null,

  // ── List / selection ─────────────────────

  loadTeams: async (spaceId) => {
    set({ isLoadingList: true, error: null })
    try {
      const res = await api.teamList(spaceId)
      if (res.success && Array.isArray(res.data)) {
        set({ teams: sortTeams(res.data as TeamListItem[]) })
      } else {
        set({ error: (res.error as string) || i18n.t('Couldn\u2019t load your offices. Please try again.') })
      }
    } catch (err) {
      console.error('[TeamStore] loadTeams error:', err)
      set({ error: i18n.t('Couldn\u2019t load your offices. Please try again.') })
    } finally {
      set({ isLoadingList: false })
    }
  },

  selectTeam: (teamId) => {
    if (teamId === get().currentTeamId) return
    set({
      currentTeamId: teamId,
      detail: null,
      activeFlows: [],
      epochs: [],
      conversations: [],
      selectedConversationId: null,
    })
    if (teamId) {
      void get().loadDetail(teamId)
      void get().loadEpochs(teamId)
      void get().loadConversations(teamId)
    }
  },

  loadDetail: async (teamId) => {
    // Snapshot the current roster so we can tell if someone new joined once the
    // refetch lands (null when this is the first load of this team = no toast).
    const prev = get().detail
    const prevMembers = prev && prev.team.id === teamId ? prev.members : null
    set({ isLoadingDetail: true, error: null })
    try {
      const res = await api.teamGetDetail(teamId)
      // Guard against races: ignore stale responses for a no-longer-selected team.
      if (get().currentTeamId !== teamId) return
      if (res.success && res.data) {
        const detail = res.data as TeamDetail
        // A remote member present now but not before = someone else's machine joined.
        if (prevMembers) {
          const known = new Set(prevMembers.map(m => m.appId))
          notifyMembersJoined(detail.team.name, detail.members.filter(m => isRemoteMember(m) && !known.has(m.appId)))
        }
        set({ detail })
      } else if (!res.success) {
        set({ error: (res.error as string) || i18n.t('Couldn\u2019t open this office. Please try again.') })
      }
    } catch (err) {
      console.error('[TeamStore] loadDetail error:', err)
      set({ error: i18n.t('Couldn\u2019t open this office. Please try again.') })
    } finally {
      if (get().currentTeamId === teamId) set({ isLoadingDetail: false })
    }
  },

  loadEpochs: async (teamId) => {
    set({ isLoadingEpochs: true })
    try {
      const res = await api.teamListEpochs(teamId)
      if (get().currentTeamId !== teamId) return
      if (res.success && Array.isArray(res.data)) {
        set({ epochs: res.data as TeamEpochSummary[] })
      }
    } catch (err) {
      console.error('[TeamStore] loadEpochs error:', err)
    } finally {
      if (get().currentTeamId === teamId) set({ isLoadingEpochs: false })
    }
  },

  loadEpochBoard: async (teamId, epochId) => {
    try {
      const res = await api.teamEpochBoard(teamId, epochId)
      if (res.success && res.data) return res.data as EpochBoard
      return null
    } catch (err) {
      console.error('[TeamStore] loadEpochBoard error:', err)
      return null
    }
  },

  // ── Conversations ────────────────────────

  loadConversations: async (teamId) => {
    set({ isLoadingConversations: true })
    try {
      const res = await api.teamListConversations(teamId)
      if (get().currentTeamId !== teamId) return
      if (res.success && Array.isArray(res.data)) {
        const conversations = res.data as TeamConversation[]
        // Keep the current selection if it still exists; else fall back to the
        // first writable conversation (never auto-select a read-only IM chat).
        const sel = get().selectedConversationId
        const stillThere = sel && conversations.some(c => c.epochId === sel)
        set({
          conversations,
          selectedConversationId: stillThere
            ? sel
            : conversations.find(c => !c.readonly)?.epochId ?? conversations[0]?.epochId ?? null,
        })
      }
    } catch (err) {
      console.error('[TeamStore] loadConversations error:', err)
    } finally {
      if (get().currentTeamId === teamId) set({ isLoadingConversations: false })
    }
  },

  openConversation: async (teamId, title) => {
    try {
      const res = await api.teamOpenConversation(teamId, title)
      if (res.success && res.data) {
        const epochId = (res.data as { epochId: string }).epochId
        await get().loadConversations(teamId)
        set({ selectedConversationId: epochId })
        return epochId
      }
      notifyError(i18n.t('Couldn\u2019t start a new session'), (res.error as string) || undefined)
      return null
    } catch (err) {
      console.error('[TeamStore] openConversation error:', err)
      return null
    }
  },

  renameConversation: async (teamId, epochId, title) => {
    // Optimistic: reflect the new label immediately, then confirm with the server.
    set(s => ({
      conversations: s.conversations.map(c => c.epochId === epochId ? { ...c, label: title ?? c.label } : c),
    }))
    try {
      const res = await api.teamRenameConversation(teamId, epochId, title)
      if (res.success) {
        void get().loadConversations(teamId)
        return true
      }
      return false
    } catch (err) {
      console.error('[TeamStore] renameConversation error:', err)
      return false
    }
  },

  archiveConversation: async (teamId, epochId) => {
    try {
      const res = await api.teamArchiveConversation(teamId, epochId)
      if (res.success) {
        set(s => {
          const conversations = s.conversations.filter(c => c.epochId !== epochId)
          return {
            conversations,
            selectedConversationId: s.selectedConversationId === epochId
              ? conversations.find(c => !c.readonly)?.epochId ?? null
              : s.selectedConversationId,
          }
        })
        void get().loadEpochs(teamId)
        return true
      }
      return false
    } catch (err) {
      console.error('[TeamStore] archiveConversation error:', err)
      return false
    }
  },

  selectConversation: (epochId) => set({ selectedConversationId: epochId }),

  // ── Create ───────────────────────────────

  proposeMembers: async (goal, owningSpaceId) => {
    set({ isProposing: true, error: null })
    try {
      const res = await api.teamProposeMembers(goal, owningSpaceId)
      if (res.success && Array.isArray(res.data)) {
        return res.data as ProposedMember[]
      }
      const msg = (res.error as string) || i18n.t('Failed to propose members')
      set({ error: msg })
      notifyError(i18n.t('Could not build the team'), msg)
      return null
    } catch (err) {
      console.error('[TeamStore] proposeMembers error:', err)
      // What SF-021 removed was naming a cause we had not established — it used
      // to say the model was unavailable. It did not mean the thrown text has
      // to reach the screen. The main-process handler turns anything the
      // service throws into res.error above, so what lands here is what nobody
      // planned for, and its text is written for whoever debugs it.
      const msg = i18n.t('Failed to propose members')
      set({ error: msg })
      notifyError(i18n.t('Could not build the team'), msg)
      return null
    } finally {
      set({ isProposing: false })
    }
  },

  createTeam: async (input, confirmedProposal) => {
    set({ isCreating: true, error: null })
    try {
      const res = await api.teamCreate(input, confirmedProposal)
      if (res.success && res.data) {
        const team = res.data as Team
        await get().loadTeams()
        set({ currentTeamId: team.id, detail: null })
        void get().loadDetail(team.id)
        return team
      }
      const msg = (res.error as string) || i18n.t('Failed to create team')
      set({ error: msg })
      notifyError(i18n.t('Could not create the team'), msg)
      return null
    } catch (err) {
      console.error('[TeamStore] createTeam error:', err)
      set({ error: i18n.t('Failed to create team') })
      notifyError(i18n.t('Could not create the team'), String((err as Error)?.message ?? err))
      return null
    } finally {
      set({ isCreating: false })
    }
  },

  // ── Management ────────────────────────────

  updateTeam: async (teamId, input) => {
    try {
      const res = await api.teamUpdate(teamId, input)
      if (res.success) {
        if (res.data) {
          const team = res.data as Team
          set(s => ({ detail: s.detail && s.detail.team.id === teamId ? { ...s.detail, team } : s.detail }))
        }
        await get().loadDetail(teamId)
        await get().loadTeams()
        return true
      }
      return false
    } catch (err) {
      console.error('[TeamStore] updateTeam error:', err)
      return false
    }
  },

  dissolveTeam: async (teamId) => {
    try {
      const res = await api.teamDissolve(teamId)
      if (res.success) {
        set(s => ({
          teams: s.teams.filter(t => t.id !== teamId),
          currentTeamId: s.currentTeamId === teamId ? null : s.currentTeamId,
          detail: s.currentTeamId === teamId ? null : s.detail,
        }))
        return true
      }
      return false
    } catch (err) {
      console.error('[TeamStore] dissolveTeam error:', err)
      return false
    }
  },

  leaveOffice: async (teamId) => {
    try {
      const res = await api.teamLeaveOffice(teamId)
      if (res.success) {
        set(s => ({
          teams: s.teams.filter(t => t.id !== teamId),
          currentTeamId: s.currentTeamId === teamId ? null : s.currentTeamId,
          detail: s.currentTeamId === teamId ? null : s.detail,
        }))
        return true
      }
      return false
    } catch (err) {
      console.error('[TeamStore] leaveOffice error:', err)
      return false
    }
  },

  addMember: async (teamId, member) => {
    try {
      const res = await api.teamAddMember(teamId, member)
      if (res.success) {
        await get().loadDetail(teamId)
        await get().loadTeams()
        return true
      }
      return false
    } catch (err) {
      console.error('[TeamStore] addMember error:', err)
      return false
    }
  },

  updateMember: async (teamId, appId, input) => {
    try {
      const res = await api.teamUpdateMember(teamId, appId, input)
      if (res.success) {
        await get().loadDetail(teamId)
        return true
      }
      notifyError(res.error || i18n.t('Could not save the change.'))
      return false
    } catch (err) {
      console.error('[TeamStore] updateMember error:', err)
      return false
    }
  },

  cancelCheck: async (teamId, checkId) => {
    try {
      const res = await api.teamCancelCheck(teamId, checkId)
      if (res.success) {
        await get().loadDetail(teamId)
        return true
      }
      notifyError(res.error || i18n.t('Could not stop that check.'))
      return false
    } catch (err) {
      console.error('[TeamStore] cancelCheck error:', err)
      return false
    }
  },

  removeMember: async (teamId, appId) => {
    try {
      const res = await api.teamRemoveMember(teamId, appId)
      if (res.success) {
        await get().loadDetail(teamId)
        await get().loadTeams()
        return true
      }
      return false
    } catch (err) {
      console.error('[TeamStore] removeMember error:', err)
      return false
    }
  },

  setEdges: async (teamId, edges) => {
    try {
      const res = await api.teamSetEdges(teamId, edges)
      if (res.success) {
        set(s => (s.detail && s.detail.team.id === teamId ? { detail: { ...s.detail, edges } } : {}))
        await get().loadDetail(teamId)
        return true
      }
      return false
    } catch (err) {
      console.error('[TeamStore] setEdges error:', err)
      return false
    }
  },

  // ── Run control ──────────────────────────

  runTeam: async (teamId) => {
    try {
      const res = await api.teamRun(teamId)
      if (res.success) {
        set(s => ({
          teams: sortTeams(s.teams.map(t => t.id === teamId ? { ...t, status: 'running' } : t)),
          detail: s.detail && s.detail.team.id === teamId
            ? { ...s.detail, team: { ...s.detail.team, status: 'running' } }
            : s.detail,
        }))
        // Pull fresh detail so the board reflects the lead waking up.
        void get().loadDetail(teamId)
        return true
      }
      notifyError(i18n.t('Could not start the team'), (res.error as string) || undefined)
      return false
    } catch (err) {
      console.error('[TeamStore] runTeam error:', err)
      notifyError(i18n.t('Could not start the team'), String((err as Error)?.message ?? err))
      return false
    }
  },

  pauseTeam: async (teamId) => {
    try {
      const res = await api.teamPause(teamId)
      if (res.success) {
        set(s => ({
          teams: sortTeams(s.teams.map(t => t.id === teamId ? { ...t, status: 'idle' } : t)),
          detail: s.detail && s.detail.team.id === teamId
            ? { ...s.detail, team: { ...s.detail.team, status: 'idle' } }
            : s.detail,
        }))
        return true
      }
      notifyError(i18n.t('Could not pause the team'), (res.error as string) || undefined)
      return false
    } catch (err) {
      console.error('[TeamStore] pauseTeam error:', err)
      notifyError(i18n.t('Could not pause the team'), String((err as Error)?.message ?? err))
      return false
    }
  },

  // ── Real-time Event Handlers ──────────────

  applyTeamUpdated: (event) => {
    const { teamId, team, removed, removedReason } = event

    // A kick of one of this user's members (host-initiated) must not be a silent
    // row disappearance — tell them who was removed and from which office.
    if (event.memberKicked) {
      const officeName = get().teams.find(t => t.id === teamId)?.name
      const memberName = event.memberKicked.memberName
      useNotificationStore.getState().show({
        title: i18n.t('Member removed by host'),
        body: memberName && officeName
          ? i18n.t('"{{member}}" was removed from "{{office}}" by its host.', { member: memberName, office: officeName })
          : officeName
            ? i18n.t('One of your members was removed from "{{office}}" by its host.', { office: officeName })
            : i18n.t('One of your members was removed from an office by its host.'),
        variant: 'warning',
        duration: 6000,
      })
    }

    // An optimistic board write was rolled back (never confirmed by the office
    // authority) — the row the user saw is gone; say so instead of staying silent.
    // The detail refetch below reflects the removal on an open board.
    if (event.boardWriteDiscarded) {
      useNotificationStore.getState().show({
        title: i18n.t('Board update not saved'),
        body: i18n.t('A recent board update could not reach the office and was undone.'),
        variant: 'warning',
        duration: 6000,
      })
    }

    if (removed) {
      // A removal the user did NOT initiate (the host closed an office they joined)
      // must not just make the office vanish — tell them why. Self leave / self
      // dissolve carry no reason and stay silent.
      if (removedReason === 'dissolved-remote') {
        const existing = get().teams.find(t => t.id === teamId)
        useNotificationStore.getState().show({
          title: i18n.t('Office closed'),
          body: existing
            ? i18n.t('"{{office}}" was closed by its host.', { office: existing.name })
            : i18n.t('An office you joined was closed by its host.'),
          variant: 'warning',
          duration: 6000,
        })
      }
      set(s => ({
        teams: s.teams.filter(t => t.id !== teamId),
        currentTeamId: s.currentTeamId === teamId ? null : s.currentTeamId,
        detail: s.currentTeamId === teamId ? null : s.detail,
      }))
      return
    }

    if (team) {
      set(s => {
        const existing = s.teams.find(t => t.id === teamId)
        const item: TeamListItem = {
          id: team.id,
          name: team.name,
          status: team.status,
          memberCount: existing?.memberCount ?? s.detail?.members.length ?? 0,
          // A joined office adopts the host's status, so its 'waiting_user' is a
          // decision owed by the blocked member's owner — never by this reader.
          hasWaitingUser:
            (team.hostNodeId == null && team.status === 'waiting_user') ||
            (existing?.hasWaitingUser ?? false),
          leadAppId: team.leadAppId,
          updatedAt: team.updatedAt,
        }
        const teams = existing
          ? s.teams.map(t => t.id === teamId ? item : t)
          : [...s.teams, item]
        return {
          teams: sortTeams(teams),
          detail: s.detail && s.detail.team.id === teamId
            ? { ...s.detail, team }
            : s.detail,
        }
      })
    }

    // Detail-affecting changes (members, roster, edges) may not be expressible
    // in the lightweight team payload — refetch when this is the open team. Also
    // refresh run history so a newly started/sealed epoch appears immediately.
    if (get().currentTeamId === teamId) {
      void get().loadDetail(teamId)
      void get().loadEpochs(teamId)
      // The session list is office-shared: an epoch opened/renamed/sealed on any
      // node arrives as team:updated, so keep the Conversation tab in sync.
      void get().loadConversations(teamId)
    }
  },

  applyTeamBlackboard: (event) => {
    const { teamId, task, finding, activity } = event
    if (get().currentTeamId !== teamId) return

    set(s => {
      if (!s.detail || s.detail.team.id !== teamId) return {}
      const detail = s.detail

      if (activity) {
        // Append-only, so a repeat (a replica echo of a row this node authored)
        // is dropped rather than duplicating the feed.
        const activities = detail.activities ?? []
        if (activities.some(a => a.id === activity.id)) return {}
        return { detail: { ...detail, activities: [activity, ...activities] } }
      }
      if (task) {
        const exists = detail.tasks.some(tk => tk.id === task.id)
        const tasks = exists
          ? detail.tasks.map(tk => tk.id === task.id ? task : tk)
          : [task, ...detail.tasks]
        return { detail: { ...detail, tasks } }
      }
      if (finding) {
        const exists = detail.findings.some(f => f.id === finding.id)
        if (exists) return {}
        return { detail: { ...detail, findings: [finding, ...detail.findings] } }
      }
      return {}
    })
  },

  applyTeamMessage: (event) => {
    const { teamId, fromAppId, toAppId, messageId, ts } = event
    if (get().currentTeamId !== teamId) return

    set(s => ({
      activeFlows: [
        ...s.activeFlows.filter(f => f.id !== messageId),
        { id: messageId, fromAppId, toAppId, ts },
      ],
    }))

    // Schedule expiry so the connector line fades after a short window.
    setTimeout(() => get().expireFlows(), FLOW_TTL_MS + 100)
  },

  expireFlows: () => {
    const cutoff = Date.now() - FLOW_TTL_MS
    set(s => {
      const next = s.activeFlows.filter(f => f.ts >= cutoff)
      return next.length === s.activeFlows.length ? {} : { activeFlows: next }
    })
  },

  applyTeamPresence: (event) => {
    const { teamId, nodes } = event
    if (!teamId || !Array.isArray(nodes)) return

    const nodeMap = new Map<string, NodePresence>()
    for (const n of nodes) {
      nodeMap.set(n.nodeId, { displayName: n.displayName, status: toReachability(n.status) })
    }

    set(s => {
      const presence = new Map(s.presence)
      presence.set(teamId, nodeMap)
      return { presence }
    })
  },

  applyTeamOfficeStatus: (event) => {
    const { teamId, kind } = event
    if (!teamId || !kind) return

    // Membership refused on re-entry: unlike paused/resumed, waiting cannot fix
    // it — the user must rejoin with a fresh invite, so this is never silent.
    // Liveness is left untouched (presence already shows the office as away).
    if (kind === 'access-lost') {
      const name = get().teams.find(tm => tm.id === teamId)?.name
      useNotificationStore.getState().show({
        title: name
          ? i18n.t('Lost access to {{office}}', { office: name })
          : i18n.t('Lost access to the office'),
        body: i18n.t('This machine could not rejoin automatically. Ask for a new invite to reconnect.'),
        variant: 'warning',
        duration: 8000,
      })
      return
    }

    const wasPaused = get().officeLiveness.get(teamId) === 'paused'

    set(s => {
      const officeLiveness = new Map(s.officeLiveness)
      if (kind === 'paused') officeLiveness.set(teamId, 'paused')
      else officeLiveness.set(teamId, 'live')
      return { officeLiveness }
    })

    // Only notify when we were actually resting, so a routine authority handover
    // on an already-live office stays silent.
    if (kind !== 'paused' && wasPaused) {
      const name = get().teams.find(tm => tm.id === teamId)?.name
      useNotificationStore.getState().show({
        title: name
          ? i18n.t('{{office}} is back', { office: name })
          : i18n.t('The office is back'),
        body: i18n.t('Reconnected automatically — work picks up where it left off.'),
        variant: 'success',
        duration: 4000,
      })
    }
  },

  setPendingInviteLink: (link) => set({ pendingInviteLink: link }),

  getMemberPresence: (teamId, member) => {
    const isRemote = isRemoteMember(member)

    if (!isRemote) {
      return { reachability: 'online', ownerName: null, isRemote: false }
    }

    const node = member.ownerNodeId ? get().presence.get(teamId)?.get(member.ownerNodeId) : undefined
    return {
      reachability: node?.status ?? 'online',
      // Live node ledger first; the name persisted on the member row covers
      // nodes (joiners) whose presence view has no rows for their peers.
      ownerName: node?.displayName ?? member.ownerDisplayName ?? null,
      isRemote: true,
    }
  },
}))

/**
 * Whether a member (by appId) runs on someone else's machine. Used outside React
 * (e.g. the chat store) to decide whether a team-overlay session's transcript is
 * locally reloadable or only exists as relayed live frames. Reads the current
 * detail snapshot; returns false when the member isn't resolved yet.
 */
export function isRemoteMemberAppId(appId: string): boolean {
  const member = useTeamStore.getState().detail?.members.find(m => m.appId === appId)
  if (!member) return false
  return isRemoteMember(member)
}

/**
 * Resolve a roster member's owner + reachability by appId. Roster projections
 * carry only the appId, so this joins back to the persisted member (which holds
 * the owner node + origin) and reuses the store selector.
 *
 * Selects primitive slices (never a fresh object) so the default strict-equality
 * comparator does not loop; the projection is assembled in a memo.
 */
export function useMemberPresence(teamId: string, appId: string): MemberPresence {
  const ownerNodeId = useTeamStore(s => s.detail?.members.find(m => m.appId === appId)?.ownerNodeId)
  const origin = useTeamStore(s => s.detail?.members.find(m => m.appId === appId)?.origin)
  const ownerDisplayName = useTeamStore(s => s.detail?.members.find(m => m.appId === appId)?.ownerDisplayName)
  const node = useTeamStore(s =>
    ownerNodeId ? s.presence.get(teamId)?.get(ownerNodeId) : undefined,
  )

  return useMemo<MemberPresence>(() => {
    const isRemote = isRemoteMember({ origin, ownerNodeId })
    if (!isRemote) return { reachability: 'online', ownerName: null, isRemote: false }
    return {
      reachability: node?.status ?? 'online',
      // Live node ledger first; the name persisted on the member row covers
      // nodes (joiners) whose presence view has no rows for their peers.
      ownerName: node?.displayName ?? ownerDisplayName ?? null,
      isRemote: true,
    }
  }, [origin, ownerNodeId, ownerDisplayName, node])
}
