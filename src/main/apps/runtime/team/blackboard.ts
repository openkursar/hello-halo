/**
 * Blackboard facade: write-through to TeamStore with event emission and
 * a derived roster projection. Member status is injected to stay decoupled
 * from session state.
 */

import { randomUUID } from 'crypto'
import { broadcastToAll } from '../../../http/websocket'
import { sendToRenderer } from '../../../foundation/window.service'
import { TEAM_EVENTS } from '../../../../shared/apps/team-types'
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

export interface BlackboardDeps {
  store: TeamStore
  getMemberStatus?: (appId: string) => TeamMemberRuntimeStatus
}

export function createBlackboard(deps: BlackboardDeps): Blackboard {
  const { store } = deps
  const memberStatus = deps.getMemberStatus ?? (() => 'idle' as TeamMemberRuntimeStatus)

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
      return {
        appId: m.appId,
        memberName: m.memberName,
        role: m.role,
        isLead: m.isLead,
        spaceId: null,
        status,
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
