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
import { TEAM_EVENTS, AI_MEMBER_HARD_LIMIT } from '../../../shared/apps/team-types'
import { provisionLeadSpec } from './lead'
import type { TeamRuntime } from '../runtime/team'
import type { AppManagerService } from '../manager'
import type { AppSpec } from '../spec'
import type { AutomationSpec } from '../../../shared/apps/spec-types'
import type { Artifact } from '../../services/artifact.service'
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
} from '../../../shared/apps/team-types'

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
}

export interface TeamTriggerSync {
  syncTeam(teamId: string): void
  removeTeam(teamId: string): void
}

export interface TeamSpaceDeps {
  spaceExists: (spaceId: string) => boolean
  createMemberSpace: (params: { teamName: string; memberName: string; owningSpaceId: string }) => string
  deleteMemberSpace?: (spaceId: string) => void
  /** Absolute filesystem path of a space, to resolve relative artifact refs. */
  resolveSpacePath?: (spaceId: string) => string | null
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

export interface TeamService {
  createTeam(input: CreateTeamInput, confirmedProposal?: ProposedMember[]): Promise<Team>
  getTeam(teamId: string): Team | null
  listTeams(spaceId?: string): Team[]
  listTeamItems(spaceId?: string): TeamListItem[]
  getTeamDetail(teamId: string): TeamDetail | null
  updateTeam(teamId: string, input: UpdateTeamInput): Promise<Team>
  addMember(teamId: string, member: TeamMemberInput): Promise<TeamMember>
  removeMember(teamId: string, appId: string): Promise<void>
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

  /** No subscriptions: members are driven solely by team runs. */
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
        `You are "${member.memberName}", a member of the digital team "${teamName}".\n` +
        `Your role: ${member.role}.\n${member.responsibility}\n\n` +
        `You work on tasks assigned to you through the team. Do the hands-on work in ` +
        `your own space, write large outputs to files and share their paths, and report ` +
        `back when a task is done or when you are blocked.`,
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
      return {
        id: team.id,
        name: team.name,
        status: team.status,
        memberCount: members.filter((m) => !m.isLead).length,
        hasWaitingUser: team.status === 'waiting_user',
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
      }
    }

    return {
      team,
      members,
      edges,
      roster: members.map((m) => ({
        appId: m.appId,
        memberName: m.memberName,
        role: m.role,
        isLead: m.isLead,
        spaceId: appManager.getApp(m.appId)?.spaceId ?? null,
        status: 'idle' as const,
      })),
      tasks: [],
      findings: [],
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
    return member
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

    if (team.collabMode === 'structured') {
      regenerateStructuredEdges(requireTeam(teamId))
    }
    console.log(`${LOG_TAG} removeMember: team=${teamId} app=${appId}`)
    emitUpdated(teamId, { team: requireTeam(teamId) })
  }

  function setEdges(teamId: string, edges: TeamEdge[]): void {
    requireTeam(teamId)
    store.replaceEdgesForTeam(teamId, edges.map((e) => ({ ...e, teamId })))
    console.log(`${LOG_TAG} setEdges: team=${teamId} count=${edges.length}`)
    emitUpdated(teamId, { team: requireTeam(teamId) })
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
  }

  async function pauseTeam(teamId: string): Promise<void> {
    requireTeam(teamId)
    const rt = requireRuntime()
    await rt.sealEpoch(teamId, 'stopped')
    console.log(`${LOG_TAG} pauseTeam: team=${teamId}`)
    emitUpdated(teamId, { team: requireTeam(teamId) })
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
      const spacePath = spaceId ? deps.spaces.resolveSpacePath?.(spaceId) ?? null : null
      const path = isAbsolute(ref) ? ref : spacePath ? join(spacePath, ref) : ref

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
      return {
        id: e.id,
        startedAt: e.startedAt,
        endedAt: e.endedAt,
        endReason: e.endReason,
        summary: e.summary,
        taskCount: tasks.length,
        doneCount: tasks.filter((tk) => tk.status === 'done').length,
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

  return {
    createTeam,
    getTeam,
    listTeams,
    listTeamItems,
    getTeamDetail,
    updateTeam,
    addMember,
    removeMember,
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
