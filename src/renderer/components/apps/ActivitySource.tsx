import { ArrowUpRight, Users } from 'lucide-react'
import type { ActivityEntry } from '../../../shared/apps/app-types'
import { useTeamStore } from '../../stores/team.store'
import { useTranslation } from '../../i18n'
import { openPersonTeam } from '../../utils/people-navigation'
import { useAppsPageStore } from '../../stores/apps-page.store'

export function ActivitySource({ entry }: { entry: ActivityEntry }) {
  const { t } = useTranslation()
  const teams = useTeamStore(state => state.teams)
  const source = entry.content.source
  const teamId = source?.teamId ?? entry.content.teamContext?.teamId
  const epochId = source?.epochId ?? entry.content.teamContext?.epochId
  const team = teams.find(item => item.id === teamId)
  if (teamId) return <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"><Users size={12} /><span>{t('Team')}</span>{team ? <button onClick={() => openPersonTeam({ teamId, epochId, appId: entry.appId, entryId: entry.id, decision: entry.type === 'escalation' }, entry.appId)} className="flex min-h-7 max-w-full items-center gap-1 text-left text-primary hover:underline"><span className="break-words">{team.name}{source?.label ? ` › ${source.label}` : ''}</span><ArrowUpRight size={12} className="shrink-0" /></button> : <span>{source?.teamName ?? t('Team unavailable')}{source?.label ? ` › ${source.label}` : ''} · {t('Historical record')}</span>}</div>
  return <div className="mb-2 text-xs text-muted-foreground">{source?.kind === 'automation' ? <button className="min-h-7 text-left hover:text-primary" onClick={() => entry.sessionKey && useAppsPageStore.getState().openSessionDetail(entry.appId, entry.runId, entry.sessionKey)}>{t('Independent execution')}{source.label ? ` · ${source.label}` : ''}</button> : source?.kind === 'chat' ? t('Your conversation') : t('Historical record · source not recorded')}</div>
}
