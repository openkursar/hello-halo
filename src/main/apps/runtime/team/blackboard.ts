/**
 * Blackboard facade: write-through to TeamStore with event emission and
 * a derived roster projection. Member status is injected to stay decoupled
 * from session state.
 */

import { createBlackboardWriter } from '@hello-halo/agent-sdk/collaboration'
import type { PostTaskInput, UpdateTaskInput, PostFindingInput, PostActivityInput, PublishedRefClaim, PublishedRefConflict, BlackboardWriteRecord } from '@hello-halo/agent-sdk/collaboration'
export type { PostTaskInput, UpdateTaskInput, PostFindingInput, PostActivityInput, PublishedRefClaim, PublishedRefConflict, BlackboardWriteRecord } from '@hello-halo/agent-sdk/collaboration'
import { broadcastToAll } from '../../../http/websocket'
import { sendToRenderer } from '../../../foundation/window.service'
import { TEAM_EVENTS, isRemoteMember } from '../../../../shared/apps/team-types'
import { findConflictingPublisher } from '../../team/artifact-refs'
import type { TeamStore } from '../../team'
import { listWorkMembers } from '../../team'
import type {
  BlackboardTask,
  BlackboardSnapshot,
  RosterMember,
  RosterBusyEntry,
  TeamReadBoardFilter,
  TeamMemberRuntimeStatus,
  TeamCheckView,
} from '../../../../shared/apps/team-types'

/**
 * How many acts the AGENT-facing snapshot carries. A long-running epoch
 * accumulates hundreds, and re-reading them all every turn is what the window
 * exists to prevent.
 *
 * The window is a bound on one read, NOT on what the agent can ever learn: the
 * tool layer states how many acts it is withholding and hands over a file
 * holding all of them (`board-archive.ts`). That pairing is load-bearing — a cut
 * that is silent and unrecoverable turns "what is on the board is reliable" into
 * a lie for the one reader that cannot open the UI, and an agent that cannot
 * see an act cannot tell it apart from one that never happened.
 */
export const SNAPSHOT_ACTIVITY_LIMIT = 99

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

  const { postTask, updateTask, postFinding, postActivity } = createBlackboardWriter({
    store,
    onWrite: deps.onWrite,
    onChange: (payload) => {
      broadcastToAll(TEAM_EVENTS.blackboard, payload)
      sendToRenderer(TEAM_EVENTS.blackboard, payload)
    },
  })

  function buildRoster(teamId: string, epochId: string, tasks: BlackboardTask[]): RosterMember[] {
    const members = listWorkMembers(store, teamId, epochId)
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
    const roster = buildRoster(teamId, epochId, tasks)
    const checks = deps.getChecks?.(teamId, epochId) ?? []
    // Subject only, and only the recent tail. The full text stays on the row for
    // the UI to open on demand — an agent that needs a message verbatim has it in
    // its own transcript, and pasting bodies here would turn every board read
    // into a re-read of the whole conversation.
    const activities = store
      .listRecentActivityByEpoch(teamId, epochId, SNAPSHOT_ACTIVITY_LIMIT)
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
