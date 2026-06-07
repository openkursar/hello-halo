/** Renderer state for the Digital Team feature. */

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
  CreateTeamInput,
  UpdateTeamInput,
  ProposedMember,
  TeamUpdatedEvent,
  TeamBlackboardEvent,
  TeamMessageEvent,
  TeamEpochSummary,
  EpochBoard,
} from '../../shared/apps/team-types'

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

// ── State ────────────────────────────────────────────────────────────────────

interface TeamState {
  // ── Data ─────────────────────────────────
  teams: TeamListItem[]
  currentTeamId: string | null
  detail: TeamDetail | null
  /** Transient send signals for the flow-line animation (auto-expire). */
  activeFlows: ActiveFlow[]

  // ── Loading flags ────────────────────────
  isLoadingList: boolean
  isLoadingDetail: boolean
  isCreating: boolean
  isProposing: boolean
  error: string | null

  // ── Run history (epochs) ─────────────────
  epochs: TeamEpochSummary[]
  isLoadingEpochs: boolean

  // ── List / selection ─────────────────────
  loadTeams: (spaceId?: string) => Promise<void>
  selectTeam: (teamId: string | null) => void
  loadDetail: (teamId: string) => Promise<void>
  loadEpochs: (teamId: string) => Promise<void>
  loadEpochBoard: (teamId: string, epochId: string) => Promise<EpochBoard | null>

  // ── Create ───────────────────────────────
  proposeMembers: (goal: string, owningSpaceId: string) => Promise<ProposedMember[] | null>
  createTeam: (input: CreateTeamInput, confirmedProposal?: ProposedMember[]) => Promise<Team | null>

  // ── Management ────────────────────────────
  updateTeam: (teamId: string, input: UpdateTeamInput) => Promise<boolean>
  dissolveTeam: (teamId: string) => Promise<boolean>
  addMember: (teamId: string, member: TeamMemberInput) => Promise<boolean>
  removeMember: (teamId: string, appId: string) => Promise<boolean>
  setEdges: (teamId: string, edges: TeamEdge[]) => Promise<boolean>

  // ── Run control ──────────────────────────
  runTeam: (teamId: string) => Promise<boolean>
  pauseTeam: (teamId: string) => Promise<boolean>

  // ── Real-time Event Handlers (called from App.tsx) ──
  applyTeamUpdated: (event: TeamUpdatedEvent) => void
  applyTeamBlackboard: (event: TeamBlackboardEvent) => void
  applyTeamMessage: (event: TeamMessageEvent) => void
  /** Remove flows older than FLOW_TTL_MS (called on a timer after each message). */
  expireFlows: () => void
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

/** Sort: waiting-for-decision first, then running, then most-recent activity. */
function sortTeams(teams: TeamListItem[]): TeamListItem[] {
  const rank = (t: TeamListItem): number => {
    if (t.hasWaitingUser || t.status === 'waiting_user') return 0
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
  epochs: [],
  isLoadingEpochs: false,

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
        set({ error: (res.error as string) || 'Failed to load teams' })
      }
    } catch (err) {
      console.error('[TeamStore] loadTeams error:', err)
      set({ error: 'Failed to load teams' })
    } finally {
      set({ isLoadingList: false })
    }
  },

  selectTeam: (teamId) => {
    if (teamId === get().currentTeamId) return
    set({ currentTeamId: teamId, detail: null, activeFlows: [], epochs: [] })
    if (teamId) {
      void get().loadDetail(teamId)
      void get().loadEpochs(teamId)
    }
  },

  loadDetail: async (teamId) => {
    set({ isLoadingDetail: true, error: null })
    try {
      const res = await api.teamGetDetail(teamId)
      // Guard against races: ignore stale responses for a no-longer-selected team.
      if (get().currentTeamId !== teamId) return
      if (res.success && res.data) {
        set({ detail: res.data as TeamDetail })
      } else if (!res.success) {
        set({ error: (res.error as string) || 'Failed to load team detail' })
      }
    } catch (err) {
      console.error('[TeamStore] loadDetail error:', err)
      set({ error: 'Failed to load team detail' })
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
      set({ error: 'Failed to propose members' })
      notifyError(i18n.t('Could not build the team'), i18n.t('The AI model is unavailable. Check your AI source settings and try again.'))
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
      set({ error: 'Failed to create team' })
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
    const { teamId, team, removed } = event

    if (removed) {
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
          hasWaitingUser: team.status === 'waiting_user' || (existing?.hasWaitingUser ?? false),
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
    }
  },

  applyTeamBlackboard: (event) => {
    const { teamId, task, finding } = event
    if (get().currentTeamId !== teamId) return

    set(s => {
      if (!s.detail || s.detail.team.id !== teamId) return {}
      const detail = s.detail

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
}))
