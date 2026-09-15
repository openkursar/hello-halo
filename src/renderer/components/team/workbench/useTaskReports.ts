import { invalidateTeamSessionHistory, loadTeamSessionHistory, matchesTeamHistory, retainTeamSessionHistory } from '../session-history'
import { useEffect, useRef, useState } from 'react'
import type { RosterMember } from '../../../../shared/apps/team-types'
import type { Message } from '../../../types'
import { api } from '../../../api'
import { taskReportMessages, type TaskMemberReport } from './model'

export function useTaskReports(teamId: string, epochId: string, roster: RosterMember[], reload: number) {
  const [reports, setReports] = useState<TaskMemberReport[]>([])
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  const historiesRef = useRef(new Map<string, TaskMemberReport[]>())
  const scopeRef = useRef(`${teamId}:${epochId}`)
  const membersKey = JSON.stringify(roster.map(member => [member.appId, member.spaceId ?? '', member.memberName]))
  useEffect(() => {
    let disposed = false
    let active = 0
    const members = JSON.parse(membersKey) as [string, string, string][]
    const releases = members.map(([id, space]) => retainTeamSessionHistory(id, space, teamId, epochId))
    const queue = new Set(members.map(([id]) => id))
    const running = new Set<string>()
    const scope = `${teamId}:${epochId}`
    if (scopeRef.current !== scope) {
      historiesRef.current.clear()
      scopeRef.current = scope
      setReports([])
    }
    const histories = historiesRef.current
    const failures = new Set<string>()
    setFailed(false)
    setLoading(true)
    const pump = () => {
      if (disposed) return
      for (const id of queue) {
        if (active >= 3) break
        if (running.has(id)) continue
        const member = members.find(([appId]) => appId === id)!
        queue.delete(id)
        running.add(id)
        active++
        void (async () => {
          try {
            const result = await loadTeamSessionHistory(id, member[1], teamId, epochId)
            if (disposed) return
            if (!result.success) throw new Error(String(result.error ?? 'History request rejected'))
            const messages = (result.data ?? []) as Message[]
            histories.set(id, taskReportMessages(messages).map(message => ({ appId: id, message })))
            if ((result as { stale?: boolean }).stale) failures.add(id)
            else failures.delete(id)
            setReports([...histories.values()].flat())
          } catch (error) {
            if (!disposed) {
              console.warn('[TaskActivity] Member reports unavailable', { teamId, epochId, appId: id, error })
              failures.add(id)
            }
          } finally {
            active--
            running.delete(id)
            if (!disposed) { setFailed(failures.size > 0); setLoading(active > 0 || queue.size > 0); pump() }
          }
        })()
      }
    }
    const unsubscribe = api.onTeamMemberHistory(data => {
      const event = data as { teamId?: string; epochId?: string; appId?: string }
      if (matchesTeamHistory(event, teamId, epochId) && event.appId && members.some(([id]) => id === event.appId)) {
        const member = members.find(([id]) => id === event.appId)!
        invalidateTeamSessionHistory(event.appId, member[1], teamId, epochId)
        if (running.has(event.appId)) return
        queue.add(event.appId)
        pump()
      }
    })
    pump()
    if (!members.length) setLoading(false)
    return () => { disposed = true; unsubscribe(); releases.forEach(release => release()) }
  }, [teamId, epochId, membersKey, reload])
  return { reports, failed, loading }
}
