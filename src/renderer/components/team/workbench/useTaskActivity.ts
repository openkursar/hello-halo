import { useMemo, useState } from 'react'
import type { TeamConversation, TeamDetail } from '../../../../shared/apps/team-types'
import { useTranslation } from '../../../i18n'
import { useTeamArtifacts, type OpenOutput } from '../TeamArtifacts'
import { useTaskReports } from './useTaskReports'
import { conversationSubtasks } from './delegations'
import { reportGaps, taskParticipants } from './model'
import type { TaskBoardState } from './useTaskBoard'

const NO_MEMBERS: TeamDetail['roster'] = []

/**
 * Everything a task's activity shows, read once per open view of it.
 * `openFile` opens outputs there (the canvas) instead of in the system application.
 */
export function useTaskActivity(detail: TeamDetail, task: TeamConversation, boardState: TaskBoardState, readReports = true, openFile?: OpenOutput) {
  const { t } = useTranslation()
  const { board } = boardState
  const [reload, setReload] = useState(0)
  const reports = useTaskReports(detail.team.id, task.epochId, readReports ? detail.roster : NO_MEMBERS, reload)
  const tasks = useMemo(() => conversationSubtasks(detail, task.epochId, board?.tasks, boardState.activities), [board?.tasks, boardState.activities, detail, task.epochId])
  const findings = useMemo(() => board?.findings ?? detail.findings.filter(row => row.epochId === task.epochId), [board?.findings, detail.findings, task.epochId])
  const activities = useMemo(() => {
    const byId = new Map(tasks.map(row => [row.id, row]))
    const labels = { done: t('Completed'), error: t('Failed'), pending: t('Pending'), in_progress: t('Working'), rejected: t('Rejected'), blocked: t('Blocked'), sent: t('Sent'), undelivered: t('Not delivered'), ok: t('Completed'), timeout: t('Timed out'), escalation: t('Needs my decision') }
    return boardState.activities.map(activity => {
      if (activity.subject.trim() || activity.body?.trim()) return activity
      const item = activity.refId ? byId.get(activity.refId) : undefined
      const status = activity.status ? labels[activity.status] : undefined
      return { ...activity, subject: [item?.title, status].filter(Boolean).join(' · ') }
    }).filter(activity => activity.subject.trim() || activity.body?.trim())
  }, [boardState.activities, tasks, t])
  const pending = useMemo(() => (detail.pendingEscalations ?? []).filter(row => row.epochId === task.epochId), [detail.pendingEscalations, task.epochId])
  const artifacts = useTeamArtifacts(detail.team.id, task.epochId, `${activities.length}:${reload}`, openFile)
  const busy = useMemo(() => detail.roster.filter(member => member.busy?.some(row => row.epochId === task.epochId)), [detail.roster, task.epochId])
  const participants = useMemo(() => taskParticipants({
    epochId: task.epochId, activities, tasks, findings, roster: detail.roster, reports: reports.reports,
    memberAppIds: [
      ...pending.map(row => row.appId),
      ...(task.waitingMemberAppIds ?? []),
      ...(task.memberAppId ? [task.memberAppId] : []),
    ],
  }), [task.epochId, task.waitingMemberAppIds, task.memberAppId, activities, tasks, findings, detail.roster, pending, reports.reports])
  const gaps = useMemo(() => reportGaps(reports.unavailable, detail.roster, participants), [reports.unavailable, detail.roster, participants])
  const retry = () => { setReload(value => value + 1); boardState.retry() }
  return { loaded: !!board, failed: boardState.failed, tasks, findings, activities, pending, artifacts, busy, participants, reports, gaps, retry }
}

export type TaskActivityData = ReturnType<typeof useTaskActivity>
