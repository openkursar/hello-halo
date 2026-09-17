import { TaskTimestamp } from './TaskTimestamp'
import { useId } from 'react'
import { AlertCircle, CheckCircle2, ChevronDown, Circle, ListTodo, Plus, Search, X } from 'lucide-react'
import type { RosterMember, TeamConversation } from '../../../../shared/apps/team-types'
import { useTranslation } from '../../../i18n'
import { useTeamViewPrefsStore } from '../../../stores/team-view-prefs.store'
import { taskGroup, taskGroups, type TaskGroup } from './model'

export function TaskSidebar({ teamId, roster, tasks, selectedId, isOwner, onSelect, onNew, query, onQuery: setQuery, status, onStatus: setStatus }: {
  query: string; onQuery: (value: string) => void; status: string; onStatus: (value: string) => void
  teamId: string; roster: RosterMember[]; tasks: TeamConversation[]; selectedId: string | null; isOwner: boolean
  onSelect: (id: string) => void; onNew: () => void
}) {
  const { t } = useTranslation()
  const listId = useId()
  const saved = useTeamViewPrefsStore(s => s.groupsByTeam[teamId])
  const setGroup = useTeamViewPrefsStore(s => s.setTaskGroup)
  const labels: Record<TaskGroup, string> = {
    attention: t('Needs my decision'), involved: t('Involving me'), mine: t('Started by me'),
    other: t('Other tasks'), reception: t('IM conversations'), automatic: t('Automated tasks'),
  }
  const descriptions: Partial<Record<TaskGroup, string>> = {
    other: t('Tasks in this team that you did not start or participate in.'),
    reception: t('Conversations received from IM channels such as WeCom.'),
  }
  const search = query.trim().toLocaleLowerCase()
  const matches = tasks.filter(task => (task.waitingForMe || status === 'all' || (status === 'completed' ? task.completed : !task.completed)) && (task.label || t('New task')).toLocaleLowerCase().includes(search))
  const waitingLabel = (task: TeamConversation) => {
    if (task.waitingForMe) return t('Waiting for your decision')
    const waiting = (task.waitingMemberAppIds ?? []).map(appId => roster.find(member => member.appId === appId)).filter((member): member is RosterMember => !!member)
    if (waiting.length > 1) return t('Waiting for {{count}} teammates’ decisions', { count: waiting.length })
    const member = waiting[0]
    if (member?.owner) return t('Waiting for {{owner}}’s decision', { owner: member.owner })
    return t('Waiting for a teammate’s decision')
  }

  return <nav aria-label={t('Tasks')} className="flex h-full min-h-0 flex-col">
    <div className="flex items-center justify-between px-3 pb-2 pt-3"><h2 className="text-sm font-medium">{t('Tasks')} <span className="ml-1 text-xs font-normal tabular-nums text-muted-foreground">{tasks.length}</span></h2>
      <button onClick={onNew} title={t('New task')} className="rounded-lg p-2 text-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" aria-label={t('New task')}><Plus size={17} /></button>
    </div>
    <div className="mx-3 mb-2 flex min-h-9 items-center gap-2 rounded-lg border border-border bg-background px-2 text-muted-foreground focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/20"><Search size={14} className="shrink-0" aria-hidden="true" />
      <input type="search" aria-label={t('Search tasks')} placeholder={t('Search tasks')} value={query} onChange={event => setQuery(event.target.value)} className="min-w-0 w-full bg-transparent py-1.5 text-xs text-foreground outline-none [&::-webkit-search-cancel-button]:appearance-none" />
      {query && <button onClick={() => setQuery('')} className="shrink-0 rounded p-1 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" aria-label={t('Clear search')}><X size={13} /></button>}
    </div>
    <div role="group" aria-label={t('Status')} className="mx-3 mb-3 flex rounded-lg bg-secondary/60 p-0.5">
      {[{ value: 'all', label: t('All') }, { value: 'open', label: t('In progress') }, { value: 'completed', label: t('Completed') }].map(option => <button key={option.value} onClick={() => setStatus(option.value)} aria-pressed={status === option.value} className={`min-w-0 flex-1 rounded-md px-1 py-1.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${status === option.value ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>{option.label}</button>)}
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
      {matches.length === 0 && <div className="px-3 py-8 text-center">
        {tasks.length ? <Search size={24} className="mx-auto mb-3 text-muted-foreground/40" /> : <ListTodo size={26} className="mx-auto mb-3 text-muted-foreground/40" />}
        <p className="text-xs font-medium">{tasks.length ? t('No matching tasks') : t('No tasks yet')}</p>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{tasks.length ? t('Try another search or status.') : t('Start with a message to your digital human.')}</p>
        <button onClick={tasks.length ? () => { setQuery(''); setStatus('all') } : onNew} className="mt-3 rounded-lg px-3 py-2 text-xs text-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{tasks.length ? t('Clear filters') : t('New task')}</button>
      </div>}
      {taskGroups.map(group => {
        const grouped = matches.filter(task => taskGroup(task) === group)
        const open = group === 'attention' || !!search || (saved?.[group] ?? (['involved', 'mine'].includes(group) || group === 'other' && isOwner))
        if (!grouped.length) return null
        return <section key={group} className="mb-3">
          {group === 'attention' ? <h3 className="flex items-center gap-1.5 px-2 py-2 text-xs font-medium text-halo-warning"><AlertCircle size={13} /><span className="flex-1">{labels[group]}</span><span className="tabular-nums">{grouped.length}</span></h3> : <button aria-expanded={open} aria-controls={`${listId}-${group}`} title={descriptions[group]} onClick={() => setGroup(teamId, group, !open)} className="flex w-full items-center gap-1.5 rounded-lg px-2 py-2 text-left text-xs text-muted-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
            <ChevronDown size={13} className={`transition-transform ${open ? '' : '-rotate-90'}`} aria-hidden="true" /><span className="flex-1">{labels[group]}</span><span className="tabular-nums">{grouped.length}</span>
          </button>}
          <div id={`${listId}-${group}`} hidden={!open} className="space-y-1">{open && grouped.map(task => <button key={task.epochId} onClick={() => onSelect(task.epochId)} title={task.label || t('New task')} aria-current={selectedId === task.epochId ? 'page' : undefined}
            className={`block w-full rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${selectedId === task.epochId ? 'border-primary/30 bg-primary/10' : task.waitingUser ? 'border-halo-warning/20 bg-halo-warning/5 hover:bg-halo-warning/10' : 'border-transparent hover:bg-secondary'}`}>
            <span className={`block truncate text-sm ${selectedId === task.epochId ? 'font-medium' : ''}`}>{task.label || t('New task')}</span>
            <span className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {task.waitingUser ? <AlertCircle size={11} className="shrink-0 text-halo-warning" /> : task.completed ? <CheckCircle2 size={11} className="shrink-0" /> : <Circle size={7} className={`shrink-0 ${task.active ? 'fill-halo-success text-halo-success' : 'text-muted-foreground/60'}`} />}
              <span className={`min-w-0 flex-1 truncate ${task.waitingUser ? 'text-halo-warning' : ''}`}>{task.waitingUser ? waitingLabel(task) : task.completed ? t('Completed') : task.active ? t('Working') : t('Ready')}</span>
              <TaskTimestamp value={task.lastActivityAt} recordId={task.epochId} format="date" className="shrink-0 tabular-nums text-muted-foreground/80" />
            </span>
          </button>)}</div>
        </section>
      })}
    </div>
  </nav>
}
