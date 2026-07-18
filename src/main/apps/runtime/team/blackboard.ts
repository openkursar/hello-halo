/**
 * Blackboard facade: write-through to TeamStore with event emission and
 * a derived roster projection. Member status is injected to stay decoupled
 * from session state.
 */

import { randomUUID } from 'crypto'
import { broadcastToAll } from '../../../http/websocket'
import { sendToRenderer } from '../../../foundation/window.service'
import { TEAM_EVENTS, isRemoteMember } from '../../../../shared/apps/team-types'
import type { TeamStore } from '../../team'
import type {
  BlackboardTask,
  BlackboardFinding,
  BlackboardSnapshot,
  RosterMember,
  TaskStatus,
  TeamReadBoardFilter,
  TeamMemberRuntimeStatus,
} from '../../../../shared/apps/team-types'

const LOG_TAG = '[Blackboard]'

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

export interface Blackboard {
  postTask(input: PostTaskInput): { taskId: string }
  updateTask(input: UpdateTaskInput): void
  postFinding(input: PostFindingInput): { findingId: string }
  readBoard(
    teamId: string,
    epochId: string,
    callerAppId: string,
    filter?: TeamReadBoardFilter
  ): BlackboardSnapshot
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
  op: 'post_task' | 'update_task' | 'post_finding'
  payload: Record<string, unknown>
  taskId?: string
}

export interface BlackboardDeps {
  store: TeamStore
  getMemberStatus?: (appId: string) => TeamMemberRuntimeStatus
  /**
   * Reachability of a member's owner, for the roster's presence column. Injected
   * (bootstrap wires it to the federation manager) so the kernel stays
   * transport-free. Returns true for a locally-owned member (always reachable) and
   * for an online remote owner; false only for a confirmed-offline remote owner.
   * Absent → every member is treated as reachable (non-federated runtime).
   */
  getMemberReachable?: (appId: string, teamId: string) => boolean
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
      const presence: RosterMember['presence'] = remote
        ? deps.getMemberReachable?.(m.appId, teamId) === false
          ? 'offline'
          : 'online'
        : 'online'
      return {
        appId: m.appId,
        memberName: m.memberName,
        role: m.role,
        isLead: m.isLead,
        spaceId: null,
        status,
        owner: remote ? m.ownerDisplayName ?? 'a teammate' : null,
        sameMachine: !remote,
        presence,
        ...(currentTask ? { currentTaskTitle: currentTask.title } : {}),
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

    if (filter?.mine) tasks = tasks.filter((t) => t.assigneeAppId === callerAppId)
    if (filter?.status) tasks = tasks.filter((t) => t.status === filter.status)

    return { tasks, findings, roster }
  }

  return { postTask, updateTask, postFinding, readBoard }
}
