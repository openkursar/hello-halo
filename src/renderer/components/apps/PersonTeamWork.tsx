import { useEffect, useMemo, useState } from 'react'
import { ArrowUpRight } from 'lucide-react'
import type { TeamDetail } from '../../../shared/apps/team-types'
import { api } from '../../api'
import { useTeamStore } from '../../stores/team.store'
import { useTranslation } from '../../i18n'
import { openPersonTeam } from '../../utils/people-navigation'

export function PersonTeamWork({ appId }: { appId: string }) {
  const { t } = useTranslation()
  const teams = useTeamStore(state => state.teams)
  const memberships = useMemo(() => teams.filter(team => team.localMembers.some(member => member.appId === appId)), [teams, appId])
  const [limit, setLimit] = useState(6)
  const [revision, setRevision] = useState(0)
  const [details, setDetails] = useState<Record<string, TeamDetail>>({})
  const [failed, setFailed] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const ids = memberships.slice(0, limit).map(team => team.id).join('\n')
  useEffect(() => {
    let active = true
    const pending = ids ? ids.split('\n') : []
    const next: Record<string, TeamDetail> = {}, errors: string[] = []
    setLoading(true)
    const worker = async () => {
      while (active && pending.length) {
        const teamId = pending.shift()!
        try {
          const result = await api.teamGetDetail(teamId)
          if (!result.success || !result.data) throw new Error(result.error ?? 'Team detail unavailable')
          next[teamId] = result.data as TeamDetail
        } catch (error) { errors.push(teamId); console.warn('[PersonTeamWork] Team activity unavailable', { appId, teamId, error }) }
      }
    }
    void Promise.all([worker(), worker(), worker()]).then(() => { if (active) { setDetails(next); setFailed(errors); setLoading(false) } })
    return () => { active = false }
  }, [ids, appId, revision])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => { if (!timer) timer = setTimeout(() => { timer = undefined; setRevision(value => value + 1) }, 500) }
    const off = [api.onTeamBlackboard(refresh), api.onTeamPresence(refresh), api.onTeamUpdated(refresh)]
    return () => { off.forEach(unsubscribe => unsubscribe()); if (timer) clearTimeout(timer) }
  }, [])
  if (!memberships.length) return null
  return <section className="mb-7 rounded-xl border border-border p-4"><div className="flex items-center justify-between gap-3"><h2 className="text-sm font-medium">{t('Current team work')}</h2><button disabled={loading} onClick={() => setRevision(value => value + 1)} className="min-h-8 text-xs text-primary disabled:opacity-50">{loading ? t('Updating…') : t('Refresh')}</button></div>
    {memberships.slice(0, limit).map(team => {
      const detail = details[team.id], member = detail?.roster.find(item => item.appId === appId)
      const unavailable = failed.includes(team.id) || !member
      return <div key={team.id} className="mt-3 border-t border-border pt-3"><p className="text-xs font-medium">{team.name}</p>{detail?.team.hostNodeId && <p className="mt-1 text-xs text-muted-foreground">{t('Last synced team activity')}</p>}
        {unavailable ? <p className="mt-2 text-xs text-muted-foreground">{loading ? t('Loading…') : t('Current activity is unavailable.')}</p> : member.presence === 'offline' ? <p className="mt-2 text-xs text-muted-foreground">{t('Member is offline. Current activity is unknown.')}</p> : member.busy?.length ? member.busy.map(work => <button key={work.epochId} onClick={() => openPersonTeam({ teamId: team.id, epochId: work.epochId, appId }, appId)} className="mt-2 flex min-h-9 w-full items-center justify-between gap-2 text-left text-xs text-primary"><span className="min-w-0 break-words">{work.label}</span><ArrowUpRight size={13} className="shrink-0" /></button>) : <p className="mt-2 text-xs text-muted-foreground">{member.status === 'waiting_user' ? t('Waiting for your answer') : member.status === 'working' ? t('Working in this team') : member.status === 'error' ? t('Team execution needs attention') : t('No current team work')}</p>}
      </div>
    })}
    {memberships.length > limit && <button onClick={() => setLimit(value => value + 6)} className="mt-3 min-h-9 text-xs text-primary">{t('Show more teams')}</button>}
  </section>
}
