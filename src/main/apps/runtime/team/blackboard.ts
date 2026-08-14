/**
 * Blackboard facade: write-through to TeamStore with event emission and
 * a derived roster projection. Member status is injected to stay decoupled
 * from session state.
 */

import { randomUUID } from 'crypto'
import { broadcastToAll } from '../../../http/websocket'
import { sendToRenderer } from '../../../foundation/window.service'
import { TEAM_EVENTS, isRemoteMember } from '../../../../shared/apps/team-types'
import { findConflictingPublisher } from '../../team/artifact-refs'
import type { TeamStore } from '../../team'
import type {
  BlackboardTask,
  BlackboardFinding,
  BlackboardSnapshot,
  RosterMember,
  RosterBusyEntry,
  TaskStatus,
  TeamActivity,
  TeamActivityKind,
  TeamActivityStatus,
  TeamReadBoardFilter,
  TeamMemberRuntimeStatus,
  TeamCheckView,
} from '../../../../shared/apps/team-types'

const LOG_TAG = '[Blackboard]'

/**
 * How many acts the AGENT-facing snapshot carries. A long-running epoch
 * accumulates hundreds; the whole point of the record is that the digest and
 * the UI can reach it, not that every turn re-reads it in full.
 */
const SNAPSHOT_ACTIVITY_LIMIT = 60

export interface PostTaskInput {
  teamId: string
  epochId: string
  callerAppId: string
  title: string
  assigneeAppId: string | null
  parentId?: string
}

export interface UpdateTaskInput {
  teamId: string
  epochId: string
  taskId: string
  status: TaskStatus
  resultRef?: string
  note?: string
}

export interface PostFindingInput {
  teamId: string
  epochId: string
  callerAppId: string
  content?: string
  ref?: string
}

/**
 * Which publication form is claiming a ref, so the board can name the app that
 * will OWN it: a finding belongs to its author, a task's resultRef to the
 * ASSIGNEE — who may not be the member calling the tool.
 */
export type PublishedRefClaim =
  | { kind: 'finding'; authorAppId: string }
  | { kind: 'task'; taskId: string }

/** The teammate already publishing a ref someone else is about to claim. */
export interface PublishedRefConflict {
  memberName: string
}

/**
 * One coordination act to record. `id` may be supplied by a caller that already
 * owns a stable identifier (the message bus mints an envelope id before the act
 * is recorded), so the recorded row and the thing it describes share one key.
 */
export interface PostActivityInput {
  teamId: string
  epochId: string
  kind: TeamActivityKind
  actorAppId: string
  targetAppId?: string | null
  subject: string
  body?: string | null
  refId?: string | null
  correlationId?: string | null
  status?: TeamActivityStatus | null
  id?: string
}

export interface Blackboard {
  postTask(input: PostTaskInput): { taskId: string }
  updateTask(input: UpdateTaskInput): void
  postFinding(input: PostFindingInput): { findingId: string }
  /**
   * Append one act to the office record. Append-only: an answer is recorded as a
   * new `reply` act carrying the original's `correlationId`, never as an edit of
   * the message row.
   */
  postActivity(input: PostActivityInput): { activityId: string }
  readBoard(
    teamId: string,
    epochId: string,
    callerAppId: string,
    filter?: TeamReadBoardFilter
  ): BlackboardSnapshot
  /**
   * Is another member already publishing this ref? Two members can pick one name
   * for two files, and once both are on the board nothing downstream can tell
   * them apart. Null = the name is free, or is already this claimant's own.
   */
  findPublishedRefConflict(input: {
    teamId: string
    epochId: string
    ref: string
    claim: PublishedRefClaim
  }): PublishedRefConflict | null
}

/**
 * A structured blackboard write, surfaced AFTER a successful local store write so
 * a replication layer can sequence and replicate it. Notification-only — the
 * write has already been applied locally when it fires. `payload` is the full
 * structured row/patch so a hot-standby can apply it verbatim.
 */
export interface BlackboardWriteRecord {
  teamId: string
  epochId: string
  op:
    | 'post_task'
    | 'update_task'
    | 'post_finding'
    | 'post_activity'
    | 'epoch_upsert'
    | 'member_profile'
    | 'check_upsert'
    | 'check_delete'
  payload: Record<string, unknown>
  taskId?: string
}

export interface BlackboardDeps {
  store: TeamStore
  getMemberStatus?: (appId: string) => TeamMemberRuntimeStatus
  /**
   * Everything a member is serving right now (run + conversations), each with a
   * human label generated on this side (the renderer performs zero translation).
   * Injected by the runtime (orchestration owns the live-session ledger). Absent
   * → roster rows carry no busy list.
   */
  getMemberBusy?: (appId: string, teamId: string) => RosterBusyEntry[]
  /**
   * Reachability of a member's owner, for the roster's presence column. Injected
   * (bootstrap wires it to the federation manager) so the kernel stays
   * transport-free. Returns true for a locally-owned member (always reachable) and
   * for an online remote owner; false only for a confirmed-offline remote owner.
   * Absent → every member is treated as reachable (non-federated runtime).
   */
  getMemberReachable?: (appId: string, teamId: string) => boolean
  /**
   * Periodic checks running in an epoch, so the board answers "what is already
   * being watched" in the same read that answers "what is already assigned".
   * Injected (the checks module is built after the board). Absent → none.
   */
  getChecks?: (teamId: string, epochId: string) => TeamCheckView[]
  /**
   * Fired AFTER each successful local blackboard write. Notification-only: the
   * write is already applied; the replication layer assigns a seq and fans the
   * entry out to hot-standbys. Absent → no replication. Must not throw into the
   * write path, so callers wrap it.
   */
  onWrite?: (record: BlackboardWriteRecord) => void
}

export function createBlackboard(deps: BlackboardDeps): Blackboard {
  const { store } = deps
  const memberStatus = deps.getMemberStatus ?? (() => 'idle' as TeamMemberRuntimeStatus)

  function notifyWrite(record: BlackboardWriteRecord): void {
    if (!deps.onWrite) return
    try {
      deps.onWrite(record)
    } catch (err) {
      // Replication is best-effort relative to the local write; never let a
      // replication-layer fault corrupt the authoritative local apply.
      console.error(`${LOG_TAG} onWrite hook threw (write already applied):`, err)
    }
  }

  function emitTask(teamId: string, epochId: string, task: BlackboardTask): void {
    const payload = { teamId, epochId, kind: 'task' as const, task }
    broadcastToAll(TEAM_EVENTS.blackboard, payload)
    sendToRenderer(TEAM_EVENTS.blackboard, payload)
  }

  function emitFinding(teamId: string, epochId: string, finding: BlackboardFinding): void {
    const payload = { teamId, epochId, kind: 'finding' as const, finding }
    broadcastToAll(TEAM_EVENTS.blackboard, payload)
    sendToRenderer(TEAM_EVENTS.blackboard, payload)
  }

  function emitActivity(teamId: string, epochId: string, activity: TeamActivity): void {
    const payload = { teamId, epochId, kind: 'activity' as const, activity }
    broadcastToAll(TEAM_EVENTS.blackboard, payload)
    sendToRenderer(TEAM_EVENTS.blackboard, payload)
  }

  function postTask(input: PostTaskInput): { taskId: string } {
    const now = Date.now()
    const task: BlackboardTask = {
      id: randomUUID(),
      teamId: input.teamId,
      epochId: input.epochId,
      title: input.title,
      assigneeAppId: input.assigneeAppId,
      status: 'pending',
      resultRef: null,
      note: null,
      parentId: input.parentId ?? null,
      createdByAppId: input.callerAppId,
      createdAt: now,
      updatedAt: now,
    }
    store.insertTask(task)
    console.log(`${LOG_TAG} postTask: team=${input.teamId} epoch=${input.epochId} task=${task.id}`)
    emitTask(input.teamId, input.epochId, task)
    notifyWrite({
      teamId: input.teamId,
      epochId: input.epochId,
      op: 'post_task',
      payload: task as unknown as Record<string, unknown>,
      taskId: task.id,
    })
    return { taskId: task.id }
  }

  function updateTask(input: UpdateTaskInput): void {
    const now = Date.now()
    store.updateTask(
      input.taskId,
      {
        status: input.status,
        ...(input.resultRef !== undefined ? { resultRef: input.resultRef } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
      now
    )
    const task = store.getTaskById(input.taskId)
    console.log(
      `${LOG_TAG} updateTask: team=${input.teamId} task=${input.taskId} status=${input.status}`
    )
    if (task) emitTask(input.teamId, input.epochId, task)
    notifyWrite({
      teamId: input.teamId,
      epochId: input.epochId,
      op: 'update_task',
      payload: {
        taskId: input.taskId,
        status: input.status,
        ...(input.resultRef !== undefined ? { resultRef: input.resultRef } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        updatedAt: now,
      },
      taskId: input.taskId,
    })
  }

  function postFinding(input: PostFindingInput): { findingId: string } {
    const finding: BlackboardFinding = {
      id: randomUUID(),
      teamId: input.teamId,
      epochId: input.epochId,
      authorAppId: input.callerAppId,
      body: input.content ?? null,
      ref: input.ref ?? null,
      createdAt: Date.now(),
    }
    store.insertFinding(finding)
    console.log(`${LOG_TAG} postFinding: team=${input.teamId} epoch=${input.epochId} finding=${finding.id}`)
    emitFinding(input.teamId, input.epochId, finding)
    notifyWrite({
      teamId: input.teamId,
      epochId: input.epochId,
      op: 'post_finding',
      payload: finding as unknown as Record<string, unknown>,
    })
    return { findingId: finding.id }
  }

  function postActivity(input: PostActivityInput): { activityId: string } {
    const activity: TeamActivity = {
      id: input.id ?? randomUUID(),
      teamId: input.teamId,
      epochId: input.epochId,
      kind: input.kind,
      actorAppId: input.actorAppId,
      targetAppId: input.targetAppId ?? null,
      subject: input.subject,
      body: input.body ?? null,
      refId: input.refId ?? null,
      correlationId: input.correlationId ?? null,
      status: input.status ?? null,
      createdAt: Date.now(),
    }
    store.insertActivity(activity)
    emitActivity(input.teamId, input.epochId, activity)
    notifyWrite({
      teamId: input.teamId,
      epochId: input.epochId,
      op: 'post_activity',
      payload: activity as unknown as Record<string, unknown>,
    })
    return { activityId: activity.id }
  }

  function buildRoster(teamId: string, tasks: BlackboardTask[]): RosterMember[] {
    const members = store.listMembersByTeam(teamId)
    return members.map((m) => {
      const status = memberStatus(m.appId)
      const currentTask =
        status === 'working'
          ? tasks.find((t) => t.assigneeAppId === m.appId && t.status === 'in_progress')
          : undefined
      // Cross-machine awareness: a remote teammate carries its owner label and is
      // shown offline when its owner is confirmed unreachable; a locally-owned
      // member is same-machine and always reachable.
      const remote = isRemoteMember(m)
      const busy = deps.getMemberBusy?.(m.appId, teamId) ?? []
      const presence: RosterMember['presence'] = remote
        ? deps.getMemberReachable?.(m.appId, teamId) === false
          ? 'offline'
          : 'online'
        : 'online'
      return {
        appId: m.appId,
        memberName: m.memberName,
        role: m.role,
        duty: m.duty ?? null,
        isLead: m.isLead,
        spaceId: null,
        status,
        owner: remote ? m.ownerDisplayName ?? 'a teammate' : null,
        sameMachine: !remote,
        presence,
        ...(currentTask ? { currentTaskTitle: currentTask.title } : {}),
        ...(busy.length > 0 ? { busy } : {}),
      }
    })
  }

  function readBoard(
    teamId: string,
    epochId: string,
    callerAppId: string,
    filter?: TeamReadBoardFilter
  ): BlackboardSnapshot {
    let tasks = store.listTasksByEpoch(teamId, epochId)
    const findings = store.listFindingsByEpoch(teamId, epochId)
    const roster = buildRoster(teamId, tasks)
    const checks = deps.getChecks?.(teamId, epochId) ?? []
    // Subject only, and only the recent tail. The full text stays on the row for
    // the UI to open on demand — an agent that needs a message verbatim has it in
    // its own transcript, and pasting bodies here would turn every board read
    // into a re-read of the whole conversation.
    const activities = store
      .listActivityByEpoch(teamId, epochId)
      .slice(-SNAPSHOT_ACTIVITY_LIMIT)
      .map((a) => ({ ...a, body: null }))

    if (filter?.mine) tasks = tasks.filter((t) => t.assigneeAppId === callerAppId)
    if (filter?.status) tasks = tasks.filter((t) => t.status === filter.status)

    return { tasks, findings, roster, checks, activities }
  }

  function findPublishedRefConflict(input: {
    teamId: string
    epochId: string
    ref: string
    claim: PublishedRefClaim
  }): PublishedRefConflict | null {
    const claimantAppId =
      input.claim.kind === 'finding'
        ? input.claim.authorAppId
        : store.getTaskById(input.claim.taskId)?.assigneeAppId ?? null
    const conflictAppId = findConflictingPublisher(
      store,
      input.teamId,
      input.epochId,
      input.ref,
      claimantAppId
    )
    if (!conflictAppId) return null
    const member = store.listMembersByTeam(input.teamId).find((m) => m.appId === conflictAppId)
    return { memberName: member?.memberName ?? 'another teammate' }
  }

  return { postTask, updateTask, postFinding, postActivity, readBoard, findPublishedRefConflict }
}
