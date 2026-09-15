import { ArrowUpRight, ListTodo, MessageCircle, Sparkles } from 'lucide-react'
import type { TeamConversation } from '../../../../shared/apps/team-types'
import { useTranslation } from '../../../i18n'

export function TaskStartGuide({ tasks, onTask }: { tasks: TeamConversation[]; onTask: (id: string) => void }) {
  const { t } = useTranslation()
  const active = tasks.filter(task => task.active).slice(0, 3)
  return <div className="mx-auto max-w-xl space-y-6">
    <div><Sparkles size={26} className="mb-4 text-primary" /><h2 className="text-xl font-semibold tracking-tight sm:text-2xl">{t('Start a new task')}</h2><p className="mt-3 text-sm leading-6 text-muted-foreground">{t('Each task keeps its own conversation, collaboration and results. Your first message creates the task.')}</p></div>
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-xl border border-border bg-secondary/20 p-4"><MessageCircle size={18} className="mb-3 text-primary" /><h3 className="text-sm font-medium">{t('Talk to your digital human')}</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">{t('Choose one beside the input, or select one of your members on the right. Switching members keeps you in this task.')}</p></div>
      <div className="rounded-xl border border-border bg-secondary/20 p-4"><ListTodo size={18} className="mb-3 text-primary" /><h3 className="text-sm font-medium">{t('Continue an existing task')}</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">{t('Choose a task from the task list to return to its conversation. A working member may be busy in a different task; use their task link to go there.')}</p></div>
    </div>
    {active.length > 0 && <section><h3 className="mb-2 text-xs font-medium text-muted-foreground">{t('The team is working on')}</h3><div className="space-y-2">{active.map(task => <button key={task.epochId} onClick={() => onTask(task.epochId)} className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-halo-success" /><span className="min-w-0 flex-1 truncate">{task.label}</span><ArrowUpRight size={15} className="shrink-0 text-muted-foreground" /></button>)}</div></section>}
  </div>
}
