import { ArrowUpRight, Users } from 'lucide-react'
import { openPersonTeam } from '../../../utils/people-navigation'
import { useTranslation } from '../../../i18n'
import { JsonResultViewer } from './JsonResultViewer'
import type { PeopleContextReference } from './people-context'

export function PeopleContextViewer({ references, output }: { references: PeopleContextReference[]; output: string }) {
  const { t } = useTranslation()
  return <div className="space-y-2 rounded-xl border border-border p-3">
    <p className="text-xs text-muted-foreground">{t('Team relationships available to you')}</p>
    {references.map(reference => <button key={`${reference.teamId}:${reference.epochId ?? ''}:${reference.appId}`} onClick={() => openPersonTeam({ teamId: reference.teamId, appId: reference.appId, epochId: reference.epochId })} className="flex min-h-10 w-full items-center gap-2 rounded-lg border border-border p-3 text-left text-sm hover:bg-secondary"><Users size={15} className="shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 break-words">{reference.label}</span><ArrowUpRight size={14} className="shrink-0 text-primary" /></button>)}
    {!references.length && <p className="text-sm">{t('No team links in this result.')}</p>}
    <details><summary className="min-h-8 cursor-pointer py-2 text-xs text-muted-foreground">{t('View query details')}</summary><JsonResultViewer output={output} /></details>
  </div>
}
