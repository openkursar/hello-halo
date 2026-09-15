import { useEffect, useState } from 'react'
import type { ActivityEntry, EscalationResponse } from '../../../../shared/apps/app-types'
import { api } from '../../../api'

export function useTaskDecisions(teamId: string, epochId: string | null, appIds: string[]) {
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)
  const membersKey = JSON.stringify(appIds)
  useEffect(() => {
    let disposed = false
    setEntries([])
    setFailed(false)
    if (!epochId) return
    const responses = new Map<string, EscalationResponse>()
    const belongs = (entry: ActivityEntry) => entry.type === 'escalation' && entry.content.teamContext?.teamId === teamId && entry.content.teamContext.epochId === epochId
    const merge = (incoming: ActivityEntry[]) => setEntries(current => {
      const combined = new Map(current.map(entry => [entry.id, entry]))
      for (const entry of incoming) {
        const previous = combined.get(entry.id)
        combined.set(entry.id, { ...entry, content: { ...entry.content, resolution: previous?.content.resolution ?? entry.content.resolution }, userResponse: responses.get(entry.id) ?? previous?.userResponse ?? entry.userResponse })
      }
      return [...combined.values()]
    })
    const offEntry = api.onAppActivityEntry(data => {
      const event = data as { entry?: ActivityEntry }
      if (event.entry && belongs(event.entry)) merge([event.entry])
    })
    const offResponse = api.onAppEscalationResolved(data => {
      const event = data as { entryId: string; appId?: string; teamId?: string; epochId?: string; response: EscalationResponse }
      if (event.teamId !== teamId || event.epochId !== epochId || !event.appId || !(JSON.parse(membersKey) as string[]).includes(event.appId)) return
      responses.set(event.entryId, event.response)
      setEntries(current => current.map(entry => entry.id === event.entryId ? { ...entry, userResponse: event.response } : entry))
    })
    const remaining = JSON.parse(membersKey) as string[]
    const loadMember = async () => {
      while (remaining.length && !disposed) {
        const appId = remaining.shift()!
        try {
          for (let offset = 0; !disposed; offset += 100) {
            const result = await api.appGetActivity(appId, { type: 'escalation', teamId, epochId, limit: 100, offset })
            if (disposed) return
            if (!result.success) throw new Error(String(result.error ?? 'Decision history request rejected'))
            const page = result.data as ActivityEntry[]
            merge(page.filter(belongs))
            if (page.length < 100) break
          }
        } catch (error) {
          if (!disposed) {
            console.warn('[TaskDecisions] History unavailable', { teamId, epochId, appId, error })
            setFailed(true)
          }
        }
        if (disposed) return
      }
    }
    void Promise.all(Array.from({ length: Math.min(3, remaining.length) }, loadMember))
    return () => { disposed = true; offEntry(); offResponse() }
  }, [teamId, epochId, membersKey, reload])
  const answered = (entry: ActivityEntry) => setEntries(current => [...current.filter(item => item.id !== entry.id), entry])
  return { entries, failed, answered, retry: () => setReload(value => value + 1) }
}
