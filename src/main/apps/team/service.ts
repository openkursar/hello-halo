/**
 * apps/team -- Team Service
 *
 * Lifecycle + membership orchestration for Digital Teams. Depends on TeamStore,
 * App Manager, and runtime via injected accessors (never runtime/team directly,
 * to avoid import cycles). Every mutation emits `team:updated`.
 */

import { randomUUID } from 'crypto'
import { basename, isAbsolute, join } from 'path'
import { broadcastToAll } from '../../http/websocket'
import { sendToRenderer } from '../../foundation/window.service'
import {
  TEAM_EVENTS,
  AI_MEMBER_HARD_LIMIT,
  memberChatKey,
  parseMemberChatKey,
  nativeConversationChatKey,
} from '../../../shared/apps/team-types'
import { provisionLeadSpec } from './lead'
import { conversationKindOf, deriveConversationLabel } from './epoch-label'
import type { TeamRuntime } from '../runtime/team'
import type { AppManagerService } from '../manager'
import type { AppSpec } from '../spec'
import type { AutomationSpec } from '../../../shared/apps/spec-types'
import type { Artifact } from '../../services/artifact.service'
import type { ImageAttachment } from '../../../shared/types/image-attachment'
import type { TeamStore } from './types'
import type {
  Team,
  TeamMember,
  TeamEdge,
  CreateTeamInput,
  UpdateTeamInput,
  TeamMemberInput,
  ProposedMember,
  TeamDetail,
  TeamListItem,
  TeamUpdatedEvent,
  TeamEpochSummary,
  TeamTrigger,
  TeamTriggerInput,
  TeamRunTrigger,
  EpochBoard,
  TeamArtifactGroup,
  TeamArtifact,
  TeamConversation,
  TeamPendingEscalation,
  RosterMember,
  UpdateTeamMemberInput,
  TeamCheckView,
} from '../../../shared/apps/team-types'
import { isRemoteMember } from '../../../shared/apps/team-types'

const LOG_TAG = '[TeamService]'

// ── Dependency injection seam ──

export interface TeamServiceDeps {
  store: TeamStore
  appManager: AppManagerService
  getRuntime: () => TeamRuntime | null
  spaces: TeamSpaceDeps
  listArtifacts: (spaceId: string) => Promise<Artifact[]>
  proposeMembersFromGoal: (goal: string, owningSpaceId: string) => Promise<ProposedMember[]>
  /**
   * Late-bound to avoid a runtime<->service import cycle: the scheduler is
   * constructed with this service's runTeam.
   */
  getTriggerSync?: () => TeamTriggerSync | null

  // ── Federation egress hooks (injected; the service never imports federation) ──
  //
  // Membership/lifecycle mutations are projected to a hosted office's joiners so a
  // remote roster converges on EVERY change, not only on join. Bootstrap wires
  // each to the FederationManager egress API. Absent (single-machine / not hosted)
  // → a no-op. The dependency direction stays downward: the service emits a local
  // event and fires these callbacks; it knows nothing of frames or transport.

  /** A membership/edge change occurred → re-project the office roster. */
  onRosterMutated?: (teamId: string) => void
  /**
   * An owner rewrote one of its own members' duty (or flipped whether it accepts
   * periodic checks). Those are office-shared facts, so on a joined office they
   * must reach the authority — a roster re-projection alone would only travel the
   * other way. Absent (not federated / hosted here) → the roster hook suffices.
   */
  onMemberProfileChanged?: (teamId: string, appId: string) => void
  /**
   * A run started or stopped → push the live run-state (team status + the active
   * epoch) to joiners so a remote status board goes live the instant the host
   * presses Run (and rests when it stops). Bootstrap wires this to a throttled
   * roster refresh.
   */
  onRunStateChanged?: (teamId: string) => void
  /** A member was removed → project a `member-removed` frame + re-project roster. */
  onMemberRemoved?: (teamId: string, appId: string) => void
  /** The office was dissolved → project an `office-dissolved` frame. */
  onOfficeDissolved?: (teamId: string) => void

  /**
   * Unanswered escalations across all apps (activity-store truth that survives a
   * run seal, P0-5). Bootstrap wires it to the runtime activity store; the
   * service maps the team's members onto it. Absent → no pending decisions.
   */
  getPendingEscalations?: () => PendingEscalationRecord[]
  /**
   * Human name for an IM chatKey (IM session registry), used when labeling an IM
   * conversation. Absent → the raw chat id is shown.
   */
  describeChatKey?: (teamId: string, chatKey: string) => string | null
}

/** One unanswered escalation as read from the activity store (bootstrap-injected). */
export interface PendingEscalationRecord {
  appId: string
  entryId: string
  question: string
  teamId?: string
  epochId?: string
  taskId?: string
}

export interface TeamTriggerSync {
  syncTeam(teamId: string): void
  removeTeam(teamId: string): void
}

export interface TeamSpaceDeps {
  spaceExists: (spaceId: string) => boolean
  createMemberSpace: (params: { teamName: string; memberName: string; owningSpaceId: string }) => string
  deleteMemberSpace?: (spaceId: string) => void
  /**
   * The directory a space's agent works in — where its published artifacts
   * actually live. Not the space's internal bookkeeping path; the two differ for
   * a space pointed at a project folder.
   */
  resolveWorkDir?: (spaceId: string) => string | null
}

/** Build an openable artifact entry from a declared blackboard ref (no FS scan). */
function buildRefArtifact(path: string, ref: string, spaceId: string | null, createdAt: string): TeamArtifact {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return {
    id: path,
    spaceId: spaceId ?? '',
    conversationId: '',
    name,
    type: 'file',
    path,
    relativePath: ref,
    extension,
    icon: '',
    createdAt,
  }
}

/**
 * Whose teammate this is, for the roster projections built here (the board's own
 * projection lives in runtime/team/blackboard). Without it a reader cannot tell
 * a teammate's digital human from its own, and everything the roster says —
 * "waiting for a decision" above all — reads as if it were addressed to them.
 * `owner` stays null when the name has not been advertised yet; `sameMachine` is
 * the unambiguous test.
 */
function projectOwnership(member: TeamMember): Pick<RosterMember, 'owner' | 'sameMachine'> {
  const remote = isRemoteMember(member)
  return {
    owner: remote ? member.ownerDisplayName ?? null : null,
    sameMachine: !remote,
  }
}

export interface TeamService {
  createTeam(input: CreateTeamInput, confirmedProposal?: ProposedMember[]): Promise<Team>
  getTeam(teamId: string): Team | null
  listTeams(spaceId?: string): Team[]
  listTeamItems(spaceId?: string): TeamListItem[]
  getTeamDetail(teamId: string): TeamDetail | null
  updateTeam(teamId: string, input: UpdateTeamInput): Promise<Team>
  addMember(teamId: string, member: TeamMemberInput): Promise<TeamMember>
  /**
   * Change what a member of YOUR OWN is responsible for here, and what teammates
   * may make it do. Refuses on a member someone else brought — you can read
   * their duty, not rewrite it.
   */
  updateMember(teamId: string, appId: string, input: UpdateTeamMemberInput): TeamMember
  removeMember(teamId: string, appId: string): Promise<void>
  /** Stop one periodic check outright, without going through an agent. */
  cancelCheck(teamId: string, checkId: string): void
  setEdges(teamId: string, edges: TeamEdge[]): void
  proposeMembers(goal: string, owningSpaceId: string): Promise<ProposedMember[]>
  runTeam(teamId: string, trigger?: TeamRunTrigger): Promise<void>
  pauseTeam(teamId: string): Promise<void>
  dissolveTeam(teamId: string): Promise<void>
  listTriggers(teamId: string): TeamTrigger[]
  setTrigger(teamId: string, input: TeamTriggerInput, triggerId?: string): TeamTrigger
  removeTrigger(teamId: string, triggerId: string): void
  listArtifacts(teamId: string, epochId?: string): Promise<TeamArtifactGroup[]>
  listEpochs(teamId: string): TeamEpochSummary[]
  getEpochBoard(teamId: string, epochId: string): EpochBoard | null
  /**
   * Drive ONE member turn and return its reply. Position-transparent: a
   * remote-owned target is woken on its owner node over the office link and the
   * reply refluxes back — the caller never learns position. epochId defaults to
   * the team's current run when omitted/empty.
   */
  sendToMember(params: SendToMemberParams): Promise<SendToMemberResult>

  // ── Conversations (office-shared session objects) ──
  /** Every open conversation of this office, newest first (P0-1: office-wide consistent). */
  listConversations(teamId: string): TeamConversation[]
  /**
   * Open a brand-new native team conversation ("New session") — a fresh,
   * independent context whose input target is the team lead (front-desk mode).
   * Returns the epoch id the renderer chats against.
   */
  openConversation(teamId: string, title?: string): { epochId: string }
  /** Rename a conversation (office-shared: replicated to every node). */
  renameConversation(teamId: string, epochId: string, title: string | null): void
  /** Archive (seal) a single conversation — it moves to the History archived list. */
  archiveConversation(teamId: string, epochId: string): Promise<void>
  /** Decisions currently waiting on the user in this office (survives run seal, P0-5). */
  listPendingEscalations(teamId: string): TeamPendingEscalation[]
}

export interface SendToMemberParams {
  teamId: string
  appId: string
  epochId: string
  message: string
  /** Accepted but not yet delivered: the team message bus carries text only. */
  images?: ImageAttachment[]
  thinkingEnabled?: boolean
}

export interface SendToMemberResult {
  ok: boolean
  finalMessage: string | null
  reason?: string
}

// ── Factory ──

export function createTeamService(deps: TeamServiceDeps): TeamService {
  const { store, appManager, getRuntime, spaces } = deps

  function requireTeam(teamId: string): Team {
    const team = store.getTeamById(teamId)
    if (!team) throw new Error(`Team not found: ${teamId}`)
    return team
  }

  function requireRuntime(): TeamRuntime {
    const rt = getRuntime()
    if (!rt) throw new Error('Team runtime is not yet initialized. Please try again shortly.')
    return rt
  }

  function emitUpdated(teamId: string, payload: Omit<TeamUpdatedEvent, 'teamId'>): void {
    const event: TeamUpdatedEvent = { teamId, ...payload }
    broadcastToAll(TEAM_EVENTS.updated, event as unknown as Record<string, unknown>)
    sendToRenderer(TEAM_EVENTS.updated, event)
  }

  // ── Member-name uniqueness ──

  function uniqueMemberName(teamId: string, preferred: string): string {
    const base = (preferred || 'member').trim() || 'member'
    if (!store.getMemberByName(teamId, base)) return base
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base}-${i}`
      if (!store.getMemberByName(teamId, candidate)) return candidate
    }
    return `${base}-${randomUUID().slice(0, 8)}`
  }

  // ── Member-app provisioning ──

  /**
   * The persona only — who this digital human is and how it works. Everything
   * that is true of it only INSIDE a team (the team, its role there, what it is
   * responsible for) is deliberately absent: those live on the member row and
   * are rendered into every team turn by the Team Entry. Duplicating them here
   * would freeze a second copy that the owner's later edits can never reach.
   *
   * No subscriptions: members are driven solely by team runs.
   */
  function buildMemberSpec(member: ProposedMember, teamName: string): AutomationSpec {
    return {
      spec_version: '1',
      name: `${teamName} · ${member.memberName}`,
      version: '1.0',
      author: 'Halo',
      description: member.responsibility,
      type: 'automation',
      icon: '🤝',
      system_prompt:
        `You are "${member.memberName}", ${member.role}.\n\n` +
        `Do the hands-on work in your own space, write large outputs to files and ` +
        `share their paths, and say clearly when a piece of work is done or when ` +
        `you are blocked.`,
      store: { install_source: 'manual' as const },
    }
  }

  async function createAiMember(
    team: Team,
    proposed: ProposedMember
  ): Promise<TeamMember> {
    const memberName = uniqueMemberName(team.id, proposed.memberName)
    const spaceId = spaces.createMemberSpace({
      teamName: team.name,
      memberName,
      owningSpaceId: team.owningSpaceId,
    })
    const spec = buildMemberSpec({ ...proposed, memberName }, team.name)
    // The shared AutomationSpec is structurally a validated AppSpec; the cast
    // bridges the renderer-safe contract type to the manager's Zod-inferred one.
    const appId = await appManager.install(spaceId, spec as AppSpec, {})

    const member: TeamMember = {
      teamId: team.id,
      appId,
      memberName,
      role: proposed.role,
      // The AI's own description of what this member is for becomes its starting
      // duty, so a team built this way is not born mute — the user edits from
      // something real instead of an empty box.
      duty: proposed.responsibility?.trim() || null,
      isLead: false,
      aiProvisioned: true,
      addedAt: Date.now(),
    }
    store.addMember(member)
    return member
  }

  function addManualMember(team: Team, input: TeamMemberInput): TeamMember {
    const app = appManager.getApp(input.appId)
    if (!app) throw new Error(`App not found for member: ${input.appId}`)
    const memberName = uniqueMemberName(team.id, input.memberName || app.spec.name || 'member')
    const member: TeamMember = {
      teamId: team.id,
      appId: input.appId,
      memberName,
      role: input.role ?? '',
      duty: input.duty?.trim() || null,
      isLead: false,
      aiProvisioned: false,
      addedAt: Date.now(),
    }
    store.addMember(member)
    return member
  }

  // ── Lead provisioning ──

  async function provisionLead(team: Team): Promise<string> {
    const req = provisionLeadSpec({
      teamName: team.name,
      goal: team.goal,
      owningSpaceId: team.owningSpaceId,
    })
    const leadAppId = await appManager.install(req.spaceId, req.spec as AppSpec, req.userConfig)
    store.updateTeamLeadAppId(team.id, leadAppId)

    // CRITICAL: the lead must also be a member row (isLead:true). The runtime
    // resolves the lead as a team participant exclusively through team_members
    // (buildPromptContext / roster / topology); without this row the lead's turn
    // gets no Team Entry and no halo-team tools, so a run does nothing. The lead
    // app is system-created, so aiProvisioned:true makes dissolve clean it up as
    // an orphan (no separate lead-cleanup path needed).
    store.addMember({
      teamId: team.id,
      appId: leadAppId,
      memberName: uniqueMemberName(team.id, 'Lead'),
      role: 'Team Lead',
      isLead: true,
      aiProvisioned: true,
      addedAt: Date.now(),
    })
    return leadAppId
  }

  /** If not already a member, attach as one so the runtime can resolve it. */
  function promoteExistingLead(team: Team, leadAppId: string): void {
    const members = store.listMembersByTeam(team.id)
    if (members.some((m) => m.appId === leadAppId)) {
      store.setMemberLead(team.id, leadAppId, true)
      return
    }
    const app = appManager.getApp(leadAppId)
    store.addMember({
      teamId: team.id,
      appId: leadAppId,
      memberName: uniqueMemberName(team.id, app?.spec.name || 'Lead'),
      role: 'Team Lead',
      isLead: true,
      aiProvisioned: false,
      addedAt: Date.now(),
    })
  }

  // ── Default topology (structured mode) ──

  function defaultEdges(teamId: string, leadAppId: string | null, members: TeamMember[]): TeamEdge[] {
    if (!leadAppId) return []
    return members
      .filter((m) => m.appId !== leadAppId)
      .map((m) => ({ teamId, fromAppId: leadAppId, toAppId: m.appId, sync: true }))
  }

  function regenerateStructuredEdges(team: Team): void {
    const members = store.listMembersByTeam(team.id)
    store.replaceEdgesForTeam(team.id, defaultEdges(team.id, team.leadAppId, members))
  }

  // ── createTeam ──

  async function createTeam(
    input: CreateTeamInput,
    confirmedProposal?: ProposedMember[]
  ): Promise<Team> {
    if (!spaces.spaceExists(input.owningSpaceId)) {
      throw new Error(`Owning space not found: ${input.owningSpaceId}`)
    }

    const now = Date.now()
    const team: Team = {
      id: randomUUID(),
      name: input.name,
      owningSpaceId: input.owningSpaceId,
      goal: input.goal,
      leadAppId: input.leadAppId ?? null,
      memberSourcing: input.memberSourcing,
      collabMode: input.collabMode,
      escalationRouting: input.escalationRouting,
      status: 'idle',
      currentEpochId: null,
      createdAt: now,
      updatedAt: now,
    }
    store.insertTeam(team)
    console.log(`${LOG_TAG} createTeam: id=${team.id} name="${team.name}" sourcing=${team.memberSourcing}`)

    try {
      if (input.memberSourcing === 'ai') {
        const proposal = (confirmedProposal ?? []).slice(0, AI_MEMBER_HARD_LIMIT)
        if (proposal.length > AI_MEMBER_HARD_LIMIT) {
          throw new Error(`AI member proposal exceeds hard cap of ${AI_MEMBER_HARD_LIMIT}`)
        }
        for (const proposed of proposal) {
          await createAiMember(team, proposed)
        }
      } else {
        for (const m of input.members ?? []) {
          addManualMember(team, m)
        }
      }

      if (!team.leadAppId) {
        team.leadAppId = await provisionLead(team)
      } else {
        promoteExistingLead(team, team.leadAppId)
      }

      if (team.collabMode === 'structured') {
        regenerateStructuredEdges(team)
      }
    } catch (err) {
      console.error(`${LOG_TAG} createTeam failed, rolling back team=${team.id}:`, err)
      await dissolveTeamInternal(team.id, { silent: true }).catch((cleanupErr) => {
        console.warn(`${LOG_TAG} rollback cleanup error for team=${team.id}:`, cleanupErr)
      })
      throw err
    }

    const finalTeam = requireTeam(team.id)
    emitUpdated(finalTeam.id, { team: finalTeam })
    return finalTeam
  }

  // ── Reads ──

  function getTeam(teamId: string): Team | null {
    return store.getTeamById(teamId)
  }

  function listTeams(spaceId?: string): Team[] {
    return spaceId ? store.listTeamsBySpace(spaceId) : store.listTeams()
  }

  function listTeamItems(spaceId?: string): TeamListItem[] {
    return listTeams(spaceId).map((team) => {
      const members = store.listMembersByTeam(team.id)
      // Waiting decisions survive a run seal (P0-5), so a team can be idle yet
      // still have pending escalations — count them independently of run status.
      const waitingCount = pendingEscalationsForTeam(team.id).length
      // A joined office adopts the host's run status verbatim, so its
      // 'waiting_user' announces a decision owed by whoever owns the blocked
      // member — not by the reader. Only decisions raised on this machine (the
      // local escalation count) are the reader's to make.
      const blockedOnUs = team.hostNodeId == null && team.status === 'waiting_user'
      return {
        id: team.id,
        name: team.name,
        status: team.status,
        memberCount: members.filter((m) => !m.isLead).length,
        hasWaitingUser: blockedOnUs || waitingCount > 0,
        waitingCount,
        leadAppId: team.leadAppId,
        updatedAt: team.updatedAt,
      }
    })
  }

  function getTeamDetail(teamId: string): TeamDetail | null {
    const team = store.getTeamById(teamId)
    if (!team) return null

    const members = store.listMembersByTeam(teamId)
    const edges = store.listEdgesByTeam(teamId)
    // Waiting decisions drive the cross-tab banner (C2) and survive a run seal.
    const pendingEscalations = pendingEscalationsForTeam(teamId)
    // Periodic checks are office-shared rows, so a joined office lists them from
    // its own replica exactly like the host does.
    const checks: TeamCheckView[] = getRuntime()?.checks.viewForTeam(teamId) ?? []

    // A JOINED shadow office mirrors a remote authority and has no local
    // team_epochs row, so getCurrentEpochForTeam never resolves the host's run
    // epoch — read the board off current_epoch_id directly instead, and overlay
    // the snapshot-projected member status (kernel getMemberStatus is host-local
    // and would read 'idle' here). Replication can land a task/finding before the
    // run-epoch pointer is materialized (or after a run rests), so fall back to
    // the epoch of the most recent replicated board row — the joiner's activity
    // feed must match the host regardless of roster-refresh timing.
    const isJoined = team.hostNodeId != null
    const joinedEpochId = isJoined
      ? (team.currentEpochId ?? store.getLatestBoardEpochId(teamId))
      : null
    if (isJoined && joinedEpochId) {
      const epochId = joinedEpochId
      const statuses = store.getJoinedMemberStatuses(teamId)
      return {
        team,
        members,
        edges,
        roster: members.map((m) => {
          // A decision of our own outranks the authority's projection: the
          // question lives on this machine, so we know it first (and still know
          // it while the authority is unreachable) — without this the person
          // being waited on is the one person who cannot see the ask.
          const status = m.awaitingDecision ? 'waiting_user' : statuses.get(m.appId) ?? 'idle'
          const taskTitle = status === 'working' ? store.getJoinedMemberTaskTitle(teamId, m.appId) : undefined
          const busy = store.getJoinedMemberBusy(teamId, m.appId)
          return {
            appId: m.appId,
            memberName: m.memberName,
            role: m.role,
            duty: m.duty ?? null,
            isLead: m.isLead,
            spaceId: appManager.getApp(m.appId)?.spaceId ?? null,
            status,
            ...projectOwnership(m),
            ...(taskTitle ? { currentTaskTitle: taskTitle } : {}),
            ...(busy.length > 0 ? { busy } : {}),
          }
        }),
        tasks: store.listTasksByEpoch(teamId, epochId),
        findings: store.listFindingsByEpoch(teamId, epochId),
        activities: store.listActivityByEpoch(teamId, epochId),
        pendingEscalations,
        checks,
      }
    }

    const epoch = store.getCurrentEpochForTeam(teamId) ?? store.listEpochsByTeam(teamId)[0] ?? null
    const runtime = getRuntime()

    if (epoch && runtime) {
      const callerAppId = team.leadAppId ?? members[0]?.appId ?? ''
      const board = runtime.blackboard.readBoard(teamId, epoch.id, callerAppId)
      return {
        team,
        members,
        edges,
        roster: board.roster,
        tasks: board.tasks,
        findings: board.findings,
        // Read from the store rather than taken off the agent-facing snapshot:
        // that one drops message bodies and keeps only a recent tail, which is
        // right for a turn's context and wrong for a person opening the feed.
        activities: store.listActivityByEpoch(teamId, epoch.id),
        pendingEscalations,
        checks,
      }
    }

    return {
      team,
      members,
      edges,
      roster: members.map((m) => {
        // With no open board, a member is idle unless it still owes the user a
        // decision from a sealed run (P0-5) — then it stays lit as waiting_user.
        const waiting = pendingEscalations.some((e) => e.appId === m.appId)
        return {
          appId: m.appId,
          memberName: m.memberName,
          role: m.role,
          duty: m.duty ?? null,
          isLead: m.isLead,
          spaceId: appManager.getApp(m.appId)?.spaceId ?? null,
          status: (waiting ? 'waiting_user' : 'idle') as RosterMember['status'],
          ...projectOwnership(m),
        }
      }),
      tasks: [],
      findings: [],
      activities: [],
      pendingEscalations,
      checks,
    }
  }

  // ── updateTeam ──

  async function updateTeam(teamId: string, input: UpdateTeamInput): Promise<Team> {
    const before = requireTeam(teamId)

    store.updateTeamFields(teamId, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.goal !== undefined ? { goal: input.goal } : {}),
      ...(input.memberSourcing !== undefined ? { memberSourcing: input.memberSourcing } : {}),
      ...(input.collabMode !== undefined ? { collabMode: input.collabMode } : {}),
      ...(input.escalationRouting !== undefined ? { escalationRouting: input.escalationRouting } : {}),
    })

    if (input.leadAppId !== undefined && input.leadAppId !== before.leadAppId) {
      store.updateTeamLeadAppId(teamId, input.leadAppId)
      // Keep the per-member is_lead flag in sync with the team's lead pointer so
      // the roster/UI and runtime selfIsLead checks agree. Demote the previous
      // lead; promote the new one (when it is a member).
      if (before.leadAppId) store.setMemberLead(teamId, before.leadAppId, false)
      if (input.leadAppId) store.setMemberLead(teamId, input.leadAppId, true)
    }

    const after = requireTeam(teamId)

    if (input.collabMode !== undefined && input.collabMode !== before.collabMode) {
      if (input.collabMode === 'free') {
        store.replaceEdgesForTeam(teamId, [])
      } else {
        regenerateStructuredEdges(after)
      }
    } else if (
      after.collabMode === 'structured' &&
      input.leadAppId !== undefined &&
      input.leadAppId !== before.leadAppId
    ) {
      regenerateStructuredEdges(after)
    }

    console.log(`${LOG_TAG} updateTeam: id=${teamId}`)
    emitUpdated(teamId, { team: after })
    // Lead change / structured-edge regen mutates the roster; re-project it to
    // joiners so they do not go stale (matches addMember/removeMember/setEdges).
    deps.onRosterMutated?.(teamId)
    return after
  }

  // ── Membership ──

  async function addMember(teamId: string, input: TeamMemberInput): Promise<TeamMember> {
    const team = requireTeam(teamId)
    const member = addManualMember(team, input)
    if (team.collabMode === 'structured') {
      regenerateStructuredEdges(team)
    }
    console.log(`${LOG_TAG} addMember: team=${teamId} app=${input.appId} name=${member.memberName}`)
    emitUpdated(teamId, { team: requireTeam(teamId) })
    deps.onRosterMutated?.(teamId)
    return member
  }

  /**
   * Only the machine that owns a member may rewrite its duty or its delegated
   * capabilities. Teammates read both through the roster; the owner is the only
   * author, which is why this refuses rather than silently no-ops.
   */
  function updateMember(teamId: string, appId: string, input: UpdateTeamMemberInput): TeamMember {
    requireTeam(teamId)
    const member = store.getMember(teamId, appId)
    if (!member) throw new Error(`Member not found: ${appId}`)
    if (isRemoteMember(member)) {
      throw new Error('This digital human belongs to a teammate — only its owner can change it.')
    }

    const policy = input.delegatedPolicy
    store.updateMemberFields(teamId, appId, {
      ...(input.duty !== undefined ? { duty: input.duty.trim() || null } : {}),
      ...(policy !== undefined
        ? {
            delegatedPolicyJson: policy ? JSON.stringify(policy) : null,
            // The one bit teammates' machines need in order to refuse a periodic
            // check early and clearly; the rest of the policy never leaves here.
            acceptsChecks: policy?.allowChecks !== false,
          }
        : {}),
    })

    const updated = store.getMember(teamId, appId)!
    console.log(`${LOG_TAG} updateMember: team=${teamId} app=${appId}`)
    emitUpdated(teamId, { team: requireTeam(teamId) })
    // Duty and the accepts-checks bit are office-shared facts; the delegated
    // policy itself is not, and nothing here publishes it.
    deps.onMemberProfileChanged?.(teamId, appId)
    deps.onRosterMutated?.(teamId)
    return updated
  }

  function cancelCheck(teamId: string, checkId: string): void {
    requireTeam(teamId)
    const check = store.getCheckById(checkId)
    if (!check || check.teamId !== teamId) return
    requireRuntime().checks.cancelById(checkId)
    emitUpdated(teamId, { team: requireTeam(teamId) })
  }

  async function removeMember(teamId: string, appId: string): Promise<void> {
    const team = requireTeam(teamId)
    const members = store.listMembersByTeam(teamId)
    const target = members.find((m) => m.appId === appId)
    if (!target) throw new Error(`Member not found: ${appId}`)

    store.removeMember(teamId, appId)

    if (target.aiProvisioned) {
      await cleanupOrphanApp(appId)
    }

    // If the removed member was the lead, reassign so the next run does not
    // resolve a phantom lead (which would wedge orchestration).
    if (team.leadAppId === appId) {
      const remaining = store.listMembersByTeam(teamId)
      const nextLead = remaining.find((m) => m.origin !== 'remote') ?? remaining[0] ?? null
      store.updateTeamLeadAppId(teamId, nextLead?.appId ?? null)
      if (nextLead) store.setMemberLead(teamId, nextLead.appId, true)
      console.log(`${LOG_TAG} removeMember: lead removed, reassigned team=${teamId} newLead=${nextLead?.appId ?? 'none'}`)
    }

    if (team.collabMode === 'structured') {
      regenerateStructuredEdges(requireTeam(teamId))
    }
    console.log(`${LOG_TAG} removeMember: team=${teamId} app=${appId}`)
    emitUpdated(teamId, { team: requireTeam(teamId) })
    deps.onMemberRemoved?.(teamId, appId)
  }

  function setEdges(teamId: string, edges: TeamEdge[]): void {
    requireTeam(teamId)
    store.replaceEdgesForTeam(teamId, edges.map((e) => ({ ...e, teamId })))
    console.log(`${LOG_TAG} setEdges: team=${teamId} count=${edges.length}`)
    emitUpdated(teamId, { team: requireTeam(teamId) })
    deps.onRosterMutated?.(teamId)
  }

  // ── AI propose-members ──

  async function proposeMembers(goal: string, owningSpaceId: string): Promise<ProposedMember[]> {
    if (!spaces.spaceExists(owningSpaceId)) {
      throw new Error(`Owning space not found: ${owningSpaceId}`)
    }
    const proposed = await deps.proposeMembersFromGoal(goal, owningSpaceId)
    const capped = proposed.slice(0, AI_MEMBER_HARD_LIMIT)
    console.log(`${LOG_TAG} proposeMembers: goal-len=${goal.length} proposed=${capped.length}`)
    return capped
  }

  // ── Run / pause epoch ──

  async function runTeam(teamId: string, trigger: TeamRunTrigger = { type: 'manual' }): Promise<void> {
    requireTeam(teamId)
    const rt = requireRuntime()
    const epoch = await rt.startEpoch(teamId, trigger)
    console.log(`${LOG_TAG} runTeam: team=${teamId} epoch=${epoch.id} trigger=${trigger.type}`)
    emitUpdated(teamId, { team: requireTeam(teamId) })
    // Push the live run-state (now running + the active epoch) to joiners so a
    // remote status board goes live at run-start, not only on a structural change.
    deps.onRunStateChanged?.(teamId)
  }

  async function pauseTeam(teamId: string): Promise<void> {
    requireTeam(teamId)
    const rt = requireRuntime()
    await rt.sealEpoch(teamId, 'stopped')
    console.log(`${LOG_TAG} pauseTeam: team=${teamId}`)
    emitUpdated(teamId, { team: requireTeam(teamId) })
    // Push the rested run-state to joiners so a remote status board steps back
    // to idle when the host stops the run.
    deps.onRunStateChanged?.(teamId)
  }

  // ── Dissolve (orphan cleanup) ──

  /** Best-effort: failures logged, never thrown. Skips apps still referenced. */
  async function cleanupOrphanApp(appId: string): Promise<void> {
    if (store.listMembersByAppId(appId).length > 0) return

    const app = appManager.getApp(appId)
    const spaceId = app?.spaceId ?? null
    try {
      await appManager.uninstall(appId, { purge: true })
      await appManager.deleteApp(appId)
      console.log(`${LOG_TAG} cleanupOrphanApp: deleted app=${appId}`)
    } catch (err) {
      console.warn(`${LOG_TAG} cleanupOrphanApp failed for app=${appId}:`, err)
    }
    if (spaceId && spaces.deleteMemberSpace) {
      try {
        spaces.deleteMemberSpace(spaceId)
      } catch (err) {
        console.warn(`${LOG_TAG} deleteMemberSpace failed for space=${spaceId}:`, err)
      }
    }
  }

  async function dissolveTeamInternal(
    teamId: string,
    opts: { silent?: boolean } = {}
  ): Promise<void> {
    const team = store.getTeamById(teamId)
    if (!team) return

    // Project office-dissolved to joiners BEFORE any teardown, while the hosted
    // office's link is still live (bootstrap projects the frame, then tears
    // down). Skipped on a silent internal dissolve (no user-facing teardown).
    if (!opts.silent) {
      deps.onOfficeDissolved?.(teamId)
    }

    if (team.status === 'running' || team.currentEpochId) {
      const rt = getRuntime()
      if (rt) {
        await rt.sealEpoch(teamId, 'stopped').catch((err) => {
          console.warn(`${LOG_TAG} dissolve sealEpoch failed for team=${teamId}:`, err)
        })
      }
    }

    const members = store.listMembersByTeam(teamId)

    // Remove rows before orphan checks so reference counts reflect post-removal state.
    for (const m of members) {
      store.removeMember(teamId, m.appId)
    }
    deps.getTriggerSync?.()?.removeTeam(teamId)
    store.deleteTriggersByTeam(teamId)
    // Periodic checks die with the team — including their alarms, which the
    // runtime disarms as each row goes.
    const rt = getRuntime()
    for (const check of store.listChecksByTeam(teamId)) rt?.checks.cancelById(check.id)
    store.deleteTeam(teamId)

    for (const m of members) {
      if (m.aiProvisioned) {
        await cleanupOrphanApp(m.appId)
      }
    }

    console.log(`${LOG_TAG} dissolveTeam: team=${teamId} members=${members.length}`)
    if (!opts.silent) {
      emitUpdated(teamId, { removed: true })
    }
  }

  async function dissolveTeam(teamId: string): Promise<void> {
    return dissolveTeamInternal(teamId)
  }

  // ── Artifacts ──

  /**
   * Products of one run, attributed to the producing member.
   *
   * Built from declared blackboard refs (task.resultRef / finding.ref), never a
   * filesystem scan: a space holds unrelated pre-existing files, so scanning it
   * would flood the view and mis-attribute ownership. Refs are the source of
   * truth; we only resolve relative refs to absolute paths.
   */
  async function listArtifacts(teamId: string, epochId?: string): Promise<TeamArtifactGroup[]> {
    requireTeam(teamId)
    const epoch = epochId
      ? store.getEpochById(epochId)
      : store.getCurrentEpochForTeam(teamId) ?? store.listEpochsByTeam(teamId)[0] ?? null
    if (!epoch) return []

    // task → assignee, finding → author; de-duplicated per member by path.
    const refs: Array<{ appId: string; ref: string }> = []
    for (const t of store.listTasksByEpoch(teamId, epoch.id)) {
      if (t.resultRef && t.assigneeAppId) refs.push({ appId: t.assigneeAppId, ref: t.resultRef })
    }
    for (const f of store.listFindingsByEpoch(teamId, epoch.id)) {
      if (f.ref) refs.push({ appId: f.authorAppId, ref: f.ref })
    }
    if (refs.length === 0) return []

    const members = store.listMembersByTeam(teamId)
    const memberById = new Map(members.map((m) => [m.appId, m]))
    const groups = new Map<string, { spaceId: string | null; seen: Set<string>; artifacts: TeamArtifact[] }>()
    const createdAt = new Date(epoch.startedAt).toISOString()

    for (const { appId, ref } of refs) {
      const member = memberById.get(appId)
      if (!member) continue
      const spaceId = appManager.getApp(appId)?.spaceId ?? null
      const workDir = spaceId ? deps.spaces.resolveWorkDir?.(spaceId) ?? null : null
      const path = isAbsolute(ref) ? ref : workDir ? join(workDir, ref) : ref

      let g = groups.get(appId)
      if (!g) {
        g = { spaceId, seen: new Set(), artifacts: [] }
        groups.set(appId, g)
      }
      if (g.seen.has(path)) continue
      g.seen.add(path)
      g.artifacts.push(buildRefArtifact(path, ref, spaceId, createdAt))
    }

    // Emit in member order, only members that produced something.
    return members
      .filter((m) => groups.get(m.appId)?.artifacts.length)
      .map((m) => {
        const g = groups.get(m.appId)!
        return { appId: m.appId, memberName: m.memberName, spaceId: g.spaceId, artifacts: g.artifacts }
      })
  }

  function listEpochs(teamId: string): TeamEpochSummary[] {
    requireTeam(teamId)
    return store.listEpochsByTeam(teamId).map((e) => {
      const tasks = store.listTasksByEpoch(teamId, e.id)
      const findings = store.listFindingsByEpoch(teamId, e.id)
      // Deliverables = distinct produced files (task resultRefs + finding refs).
      const artifactRefs = new Set<string>()
      for (const tk of tasks) if (tk.resultRef) artifactRefs.add(tk.resultRef)
      for (const f of findings) if (f.ref) artifactRefs.add(f.ref)
      return {
        id: e.id,
        startedAt: e.startedAt,
        // Board writes are activity too, and they carry a timestamp of their own
        // — folding them in keeps an epoch whose last move was a task update
        // ahead of one that only got a turn stamp earlier.
        lastActivityAt: Math.max(
          e.lastActivityAt ?? e.startedAt,
          ...tasks.map((tk) => tk.updatedAt),
          ...findings.map((f) => f.createdAt)
        ),
        endedAt: e.endedAt,
        endReason: e.endReason,
        summary: e.summary,
        taskCount: tasks.length,
        doneCount: tasks.filter((tk) => tk.status === 'done').length,
        lifecycle: e.lifecycle,
        label: e.lifecycle === 'conversation'
          ? deriveConversationLabel(store, e, deps.describeChatKey)
          : null,
        outcome: e.outcome ?? null,
        triggerType: e.triggerType ?? 'manual',
        artifactCount: artifactRefs.size,
      }
    })
  }

  function getEpochBoard(teamId: string, epochId: string): EpochBoard | null {
    requireTeam(teamId)
    const epoch = store.getEpochById(epochId)
    if (!epoch || epoch.teamId !== teamId) return null
    return {
      epoch,
      tasks: store.listTasksByEpoch(teamId, epochId),
      findings: store.listFindingsByEpoch(teamId, epochId),
      members: store.listMembersByTeam(teamId),
      activities: store.listActivityByEpoch(teamId, epochId),
    }
  }

  // ── Triggers ──

  function listTriggers(teamId: string): TeamTrigger[] {
    requireTeam(teamId)
    return store.listTriggersByTeam(teamId)
  }

  function setTrigger(teamId: string, input: TeamTriggerInput, triggerId?: string): TeamTrigger {
    requireTeam(teamId)
    const enabled = input.enabled ?? true
    if (triggerId) {
      const existing = store.getTriggerById(triggerId)
      if (!existing || existing.teamId !== teamId) {
        throw new Error(`Trigger not found for team ${teamId}: ${triggerId}`)
      }
      store.updateTrigger(triggerId, { config: input.config, enabled })
    } else {
      const trigger: TeamTrigger = {
        id: randomUUID(),
        teamId,
        sourceType: input.sourceType,
        config: input.config,
        enabled,
        createdAt: Date.now(),
      }
      store.insertTrigger(trigger)
      triggerId = trigger.id
    }
    deps.getTriggerSync?.()?.syncTeam(teamId)
    emitUpdated(teamId, { team: requireTeam(teamId) })
    return store.getTriggerById(triggerId)!
  }

  function removeTrigger(teamId: string, triggerId: string): void {
    requireTeam(teamId)
    store.deleteTrigger(triggerId)
    deps.getTriggerSync?.()?.syncTeam(teamId)
    emitUpdated(teamId, { team: requireTeam(teamId) })
  }

  async function sendToMember(params: SendToMemberParams): Promise<SendToMemberResult> {
    requireTeam(params.teamId)
    const target = store.listMembersByTeam(params.teamId).find((m) => m.appId === params.appId)
    if (!target) return { ok: false, finalMessage: null, reason: 'MEMBER_NOT_FOUND' }

    const rt = requireRuntime()

    // 1:1 direct chat must NOT require first starting a run — that leaks the internal
    // run/epoch mechanism and breaks "remote = local" (local chat needs no run). Ride
    // an OPEN run epoch when one exists (a message mid-run lands in that context),
    // else open/reuse a long-lived per-member 'conversation' epoch: a chat container
    // that does NOT trigger the run orchestration (sets no currentEpochId/status). A
    // brand-new office therefore chats fine. The history read (team:chat-messages)
    // resolves the SAME epoch via memberChatKey.
    const epochId =
      params.epochId ||
      store.getCurrentEpochForTeam(params.teamId)?.id ||
      rt.ensureConversationEpoch(params.teamId, memberChatKey(params.appId)).id

    // A sealed epoch drops completions, so the operator would see "sent, no
    // reply" after a run ended. Note the turn first (wakes a hibernated epoch); a
    // remote member's completion refluxes to this authority node, where the
    // seal check is enforced.
    rt.noteEpochTurn(params.teamId, epochId)

    // A person typed this in the member's chat, so the send carries no sender
    // app. The bus delivers it (that is how a remote member is reached) and
    // leaves no trace on the office record — a person's chat is not the team's
    // work, and borrowing the lead's identity to file it would put words in the
    // mouth of a digital human that never ran, in front of the whole office.
    const result = await rt.bus.send({
      teamId: params.teamId,
      epochId,
      fromAppId: null,
      to: target.memberName,
      message: params.message,
      wait: true,
    })

    if ('messageId' in result) return { ok: true, finalMessage: null }
    if (result.status === 'timeout') return { ok: false, finalMessage: null, reason: 'TIMEOUT' }
    // The wake never reached the member (offline/unreachable): report failure, not a
    // silent empty success, so the operator UI can show "not delivered".
    if (result.status === 'undelivered') return { ok: false, finalMessage: null, reason: 'UNDELIVERED' }
    return { ok: true, finalMessage: result.message }
  }

  // ── Conversations (office-shared session objects) ──

  /** The decisions waiting on the user for THIS team's members (survives seal). */
  function pendingEscalationsForTeam(teamId: string): TeamPendingEscalation[] {
    const all = deps.getPendingEscalations?.() ?? []
    if (all.length === 0) return []
    const members = store.listMembersByTeam(teamId)
    const nameByApp = new Map(members.map((m) => [m.appId, m.memberName]))
    const out: TeamPendingEscalation[] = []
    for (const e of all) {
      // A pending escalation belongs to this team when it is tagged with the
      // team (team turn) OR its app is a member here (defensive for legacy rows).
      const belongs = e.teamId ? e.teamId === teamId : nameByApp.has(e.appId)
      if (!belongs || !nameByApp.has(e.appId)) continue
      out.push({
        appId: e.appId,
        memberName: nameByApp.get(e.appId)!,
        entryId: e.entryId,
        question: e.question,
        ...(e.epochId ? { epochId: e.epochId } : {}),
        ...(e.taskId ? { taskId: e.taskId } : {}),
      })
    }
    return out
  }

  function listPendingEscalations(teamId: string): TeamPendingEscalation[] {
    requireTeam(teamId)
    return pendingEscalationsForTeam(teamId)
  }

  function listConversations(teamId: string): TeamConversation[] {
    const team = requireTeam(teamId)
    const openEpochs = store.listOpenConversationEpochs(teamId)
    if (openEpochs.length === 0) return []

    const members = store.listMembersByTeam(teamId)
    // An epoch is "active" when some member is serving it right now. On the
    // AUTHORITY that reads local live sessions; on a JOINED (shadow) office the
    // work runs on the host, so this node has no local sessions — it reads the
    // live busy projection the host stamped into the roster snapshot instead
    // (`getJoinedMemberBusy`). Without this branch a joiner sees every
    // conversation as idle and its "busy now" list is always empty.
    const isJoined = team.hostNodeId != null
    const rt = getRuntime()
    const activeEpochIds = new Set<string>()
    for (const m of members) {
      const busy = isJoined ? store.getJoinedMemberBusy(teamId, m.appId) : rt?.getMemberBusy(m.appId, teamId) ?? []
      for (const b of busy) activeEpochIds.add(b.epochId)
    }
    const waitingEpochIds = new Set(
      pendingEscalationsForTeam(teamId)
        .map((e) => e.epochId)
        .filter((id): id is string => !!id)
    )

    return openEpochs.map((epoch) => {
      const chatKey = epoch.chatKey ?? ''
      const kind = conversationKindOf(chatKey)
      const memberAppId = parseMemberChatKey(chatKey) ?? undefined
      return {
        epochId: epoch.id,
        teamId,
        kind,
        label: deriveConversationLabel(store, epoch, deps.describeChatKey),
        // IM chats are answered in the IM app; native + member chats are writable here.
        readonly: kind === 'im',
        ...(memberAppId ? { memberAppId } : {}),
        ...(kind === 'im' ? { channel: 'im' } : {}),
        startedAt: epoch.startedAt,
        lastActivityAt: epoch.lastActivityAt ?? epoch.startedAt,
        active: activeEpochIds.has(epoch.id),
        waitingUser: waitingEpochIds.has(epoch.id),
      }
    })
  }

  function openConversation(teamId: string, title?: string): { epochId: string } {
    requireTeam(teamId)
    const rt = requireRuntime()
    // A fresh, independent native session. The uuid makes each "New session" its
    // own context (never collapses into a prior one). The lead is the front desk.
    const epoch = rt.ensureConversationEpoch(teamId, nativeConversationChatKey(randomUUID()), title)
    console.log(`${LOG_TAG} openConversation: team=${teamId} epoch=${epoch.id}`)
    return { epochId: epoch.id }
  }

  function renameConversation(teamId: string, epochId: string, title: string | null): void {
    requireTeam(teamId)
    requireRuntime().renameConversationEpoch(teamId, epochId, title)
  }

  async function archiveConversation(teamId: string, epochId: string): Promise<void> {
    requireTeam(teamId)
    await requireRuntime().sealConversationEpoch(teamId, epochId, 'stopped')
    console.log(`${LOG_TAG} archiveConversation: team=${teamId} epoch=${epochId}`)
  }

  return {
    createTeam,
    getTeam,
    listTeams,
    listTeamItems,
    getTeamDetail,
    updateTeam,
    addMember,
    updateMember,
    removeMember,
    cancelCheck,
    setEdges,
    proposeMembers,
    runTeam,
    listTriggers,
    setTrigger,
    removeTrigger,
    pauseTeam,
    dissolveTeam,
    listArtifacts,
    listEpochs,
    getEpochBoard,
    sendToMember,
    listConversations,
    openConversation,
    renameConversation,
    archiveConversation,
    listPendingEscalations,
  }
}

// ── Default dependency builders (bootstrap-side) ──

/**
 * Credentials resolved the same way as app-chat/execute; a bare `query()`
 * without them has no credentials and fails with 403.
 */
export async function proposeMembersViaSdk(goal: string, owningSpaceId: string): Promise<ProposedMember[]> {
  const [{ query }, { getConfig }, helpers, sdkConfig] = await Promise.all([
    import('../../services/agent/resolved-sdk'),
    import('../../foundation/config.service'),
    import('../../services/agent/helpers'),
    import('../../services/agent/sdk-config'),
  ])

  const prompt =
    `You are assembling a small digital team to accomplish a goal. Propose at most ` +
    `${AI_MEMBER_HARD_LIMIT} members, each with a distinct, complementary role. Reply with ONLY a JSON ` +
    `array (no prose, no code fences), where each item is {"memberName": string, "role": string, ` +
    `"responsibility": string}. memberName is a short human-friendly handle. ` +
    `role is 2-4 words. responsibility is one concise sentence.\n\nTeam goal:\n${goal}`

  let text = ''
  try {
    const config = getConfig()
    const credentials = await helpers.getApiCredentials(config)
    const resolvedCreds = await sdkConfig.resolveCredentialsForSdk(credentials)
    const workDir = helpers.getWorkingDir(owningSpaceId)
    const electronPath = helpers.getHeadlessElectronPath()

    const options = sdkConfig.buildBaseSdkOptions({
      credentials: resolvedCreds,
      workDir,
      electronPath,
      spaceId: owningSpaceId,
      conversationId: 'team-propose-members',
      mcpServers: {},
    })
    options.maxTurns = 1
    options.allowedTools = []
    options.includePartialMessages = false
    delete options.canUseTool

    // SDK stream messages overlap; only the `result` message is authoritative.
    let resultText = ''
    let lastAssistant = ''
    for await (const msg of query({ prompt, options })) {
      const m = msg as { type?: string; result?: unknown }
      if (m?.type === 'result' && typeof m.result === 'string') {
        resultText = m.result
      } else if (m?.type === 'assistant') {
        const tx = extractText(msg)
        if (tx) lastAssistant = tx
      }
    }
    text = resultText || lastAssistant
  } catch (err) {
    console.warn(`${LOG_TAG} proposeMembersViaSdk query failed:`, err)
    return []
  }

  return parseProposedMembers(text)
}

function extractText(msg: unknown): string {
  const m = msg as { type?: string; message?: { content?: unknown }; result?: unknown }
  if (m?.type === 'result' && typeof m.result === 'string') return m.result
  const content = m?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .join('')
  }
  return ''
}

export function parseProposedMembers(raw: string): ProposedMember[] {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: ProposedMember[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const memberName = typeof o.memberName === 'string' ? o.memberName.trim() : ''
    const role = typeof o.role === 'string' ? o.role.trim() : ''
    const responsibility = typeof o.responsibility === 'string' ? o.responsibility.trim() : ''
    if (!memberName || !role) continue
    out.push({ memberName, role, responsibility })
    if (out.length >= AI_MEMBER_HARD_LIMIT) break
  }
  return out
}
