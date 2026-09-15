import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, AlertCircle, ArrowRight, Pencil, Check, X } from 'lucide-react'
import type { TeamConversation, TeamDetail } from '../../../../shared/apps/team-types'
import { isRemoteMember } from '../../../../shared/apps/team-types'
import { useTeamStore } from '../../../stores/team.store'
import { useAppsStore } from '../../../stores/apps.store'
import { useDefaultChatTarget, useTeamViewPrefsStore } from '../../../stores/team-view-prefs.store'
import { useTranslation } from '../../../i18n'
import { TeamSessionChat } from '../TeamSessionChat'
import { useTaskDecisions } from './useTaskDecisions'
import { decisionHasReceipt, isTeamBackgroundTurn } from './model'
import type { TaskBoardState } from './useTaskBoard'
import { TaskConversation } from './TaskConversation'
import { ExecutionStatus } from './ExecutionStatus'
import { TaskStartGuide } from './TaskStartGuide'
import { AutomationAvatar } from '../../apps/AutomationAvatar'

export function TaskRoom({ detail, task, onCreated, onActivity, boardState, decisionTarget, tasks, onTask, onExecution }: {
  detail: TeamDetail; task: TeamConversation | null; onCreated: (id: string) => void; onActivity: (activityId?: string) => void; boardState: TaskBoardState; decisionTarget?: string; tasks: TeamConversation[]; onTask: (id: string, decisionEntry?: boolean) => void; onExecution: (appId: string) => void
}) {
  const { t } = useTranslation()
  const apps = useAppsStore(s => s.apps)
  const own = useMemo(() => detail.members.filter(m => !isRemoteMember(m) && apps.some(app => app.id === m.appId)), [detail.members, apps])
  const ids = useMemo(() => own.map(m => m.appId), [own])
  const defaultTarget = useDefaultChatTarget(detail.team.id, ids)
  const setDefault = useTeamViewPrefsStore(s => s.setDefaultMember)
  const appId = task?.readonly ? task.memberAppId ?? detail.team.leadAppId : defaultTarget
  const member = detail.roster.find(m => m.appId === appId)
  const epochId = task?.epochId ?? null
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(task?.label ?? '')
  const [saving, setSaving] = useState(false)
  const [renameError, setRenameError] = useState(false)
  const rename = useTeamStore(s => s.renameConversation)
  const openConversation = useTeamStore(s => s.openConversation)
  const creating = useRef<Promise<string | null> | null>(null)
  const decisionHistory = useTaskDecisions(detail.team.id, epochId, ids)
  const decisions = [...new Map([
    ...(detail.pendingEscalations ?? []).filter(item => item.epochId === epochId && item.entry).map(item => [item.entryId, item.entry!] as const),
    ...decisionHistory.entries.filter(entry => entry.content.teamContext?.teamId === detail.team.id && entry.content.teamContext.epochId === epochId).map(entry => [entry.id, entry] as const),
  ]).values()]
  const pending = decisions.filter(entry => !entry.userResponse && !entry.content.resolution)
  const [focusedDecision, setFocusedDecision] = useState<string | null>(null)
  useEffect(() => { if (decisionTarget) setFocusedDecision(decisionTarget) }, [decisionTarget])
  const reminder = pending.length > 0 && <button onClick={() => {
    const entry = pending.find(item => item.appId === appId) ?? pending[0]
    if (ids.includes(entry.appId)) setDefault(detail.team.id, entry.appId)
    setFocusedDecision(entry.id)
  }} className="mb-2 flex min-h-10 w-full items-center gap-2 rounded-lg border border-halo-warning/30 bg-halo-warning/5 px-3 py-2 text-left text-xs text-halo-warning focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
    <AlertCircle size={15} className="shrink-0" /><span className="min-w-0 flex-1">{t('{{count}} decisions need your answer', { count: pending.length })}</span><span>{t('View')}</span><ArrowRight size={14} />
  </button>
  const ensureEpoch = useCallback((firstMessage: string) => {
    if (!creating.current) creating.current = openConversation(detail.team.id, Array.from(firstMessage.trim().replace(/\s+/g, ' ')).slice(0, 60).join('') || undefined).then(id => {
      if (id) onCreated(id)
      return id
    }).finally(() => { creating.current = null })
    return creating.current
  }, [detail.team.id, openConversation, onCreated])
  const refresh = () => {
    void useTeamStore.getState().loadDetail(detail.team.id)
    void useTeamStore.getState().loadConversations(detail.team.id)
  }
  const saveTitle = async () => {
    if (!epochId || !title.trim() || saving) return
    setSaving(true)
    const ok = await rename(detail.team.id, epochId, title.trim())
    setSaving(false); setRenameError(!ok)
    if (ok) setRenaming(false)
  }
  const [lastConversation, setLastConversation] = useState<{ epochId: string | null; appId: string } | null>(null)
  const rememberConversation = useCallback((id: string) => setLastConversation(previous => previous?.epochId === epochId && previous.appId === id ? previous : { epochId, appId: id }), [epochId])
  const otherDecisions = (detail.pendingEscalations ?? []).filter(entry => entry.appId === appId && entry.epochId && entry.epochId !== epochId)
  const emptyActions = <div className="mt-3 space-y-2">
    {lastConversation && lastConversation.epochId === epochId && lastConversation.appId !== appId && <button onClick={() => setDefault(detail.team.id, lastConversation.appId)} className="block min-h-8 rounded text-left text-xs text-primary hover:underline">{t('Return to your conversation with {{name}}', { name: detail.roster.find(item => item.appId === lastConversation.appId)?.memberName ?? t('Former member') })} →</button>}
    {otherDecisions.slice(0, 2).map(entry => <button key={entry.entryId} onClick={() => onTask(entry.epochId!, true)} className="block min-h-8 rounded text-left text-xs text-halo-warning hover:underline">{t('Needs your answer in {{task}}', { task: tasks.find(item => item.epochId === entry.epochId)?.label ?? t('Another task') })} →</button>)}
  </div>
  const timeline = (messages: import('../../../types').Message[], liveThoughts: import('../../../types').Thought[] = []) => <>
    <TaskConversation messages={messages} activities={boardState.activities} epochId={epochId} appId={appId ?? undefined} detail={detail} showEmpty={!!appId && !!epochId && !boardState.failed && !!boardState.board} onActivity={onActivity}
      emptyActions={emptyActions} onHumanConversation={rememberConversation} focusDecision={focusedDecision} onDecisionFocused={() => setFocusedDecision(null)} decisions={decisions.filter(entry => (entry.appId === appId || !ids.includes(entry.appId)) && !decisionHasReceipt(entry, liveThoughts))} onAnswered={entry => { decisionHistory.answered(entry); refresh() }} />
    {epochId && member && appId && isTeamBackgroundTurn(messages) && <ExecutionStatus teamId={detail.team.id} epochId={epochId} appId={appId} remote={member.sameMachine === false} busy={!!member.busy?.some(row => row.epochId === epochId)} latestResult={[...messages].reverse().find(message => message.role === 'assistant')} onOpen={() => onExecution(appId)} />}
  </>
  const picker = !task?.readonly && member ? own.length > 1 ? <label className="flex min-w-0 items-center gap-1.5 rounded-lg border border-border bg-background pl-1.5 text-xs">
    <span className="shrink-0"><AutomationAvatar name={member.memberName} size={20} /></span>
    <select aria-label={t('Choose which of your digital humans to talk to')} title={member.memberName} value={appId ?? ''} onChange={event => setDefault(detail.team.id, event.target.value)} className="min-w-0 max-w-36 truncate rounded-lg bg-background py-1.5 pl-0.5 pr-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:max-w-48">
      {own.map(m => <option key={m.appId} value={m.appId}>{m.memberName}</option>)}
    </select>
  </label> : <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={member.memberName}>
    <span className="shrink-0"><AutomationAvatar name={member.memberName} size={20} /></span><span className="max-w-32 truncate sm:max-w-48">{member.memberName}</span>
  </span> : undefined
  return <section className="flex h-full min-h-0 min-w-0 flex-col" aria-label={t('Task room')}>
    <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border px-4 py-2">
      {renaming ? <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={event => { event.preventDefault(); void saveTitle() }}>
        <input autoFocus aria-label={t('Task title')} maxLength={200} value={title} onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setRenaming(false); setRenameError(false) } }} className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm" />
        <button disabled={saving || !title.trim()} className="rounded-lg p-2 text-primary hover:bg-primary/5 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" aria-label={t('Save')}><Check size={16} /></button><button type="button" onClick={() => { setRenaming(false); setRenameError(false) }} className="rounded-lg p-2 text-muted-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" aria-label={t('Cancel')}><X size={16} /></button>
      </form> : <><h2 title={task?.label} className="min-w-0 flex-1 truncate text-sm font-medium">{task?.label || t('New task')}</h2>
        {task && <button onClick={() => { setTitle(task.label); setRenameError(false); setRenaming(true) }} aria-label={t('Rename task')} className="rounded-lg p-2 text-muted-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><Pencil size={14} /></button>}</>}
      {task?.completed && <span className="text-xs text-muted-foreground">{t('Completed')}</span>}
      {task && <button onClick={() => onActivity()} className={`flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1.5 text-xs ${pending.length ? 'border-halo-warning/30 text-halo-warning' : task.active ? 'border-halo-success/30 text-halo-success' : 'border-border text-muted-foreground'}`}><Activity size={14} />{t('Task activity')}{pending.length > 0 && <span>{pending.length}</span>}</button>}
    </header>
    {boardState.failed && <p role="alert" className="px-4 py-2 text-xs text-halo-warning">{t('Could not load collaboration updates.')} <button className="underline" onClick={boardState.retry}>{t('Retry')}</button></p>}
    {decisionHistory.failed && <p role="alert" className="px-4 py-2 text-xs text-halo-warning">{t('Could not load decision history.')} <button onClick={decisionHistory.retry} className="underline">{t('Retry')}</button></p>}
    {renameError && <p role="alert" className="p-2 text-xs text-destructive">{t('Could not rename this task. Please try again.')}</p>}
    {task?.readonly && <p className="shrink-0 border-b border-border px-4 py-2 text-xs text-muted-foreground">{task.kind === 'im' ? t('External conversation is read-only. Internal decisions can be answered here.') : t('Run history is read-only. Internal decisions can be answered here.')}</p>}
    {(task?.readonly || !appId) && <div className="shrink-0 px-3">{reminder}</div>}
    {appId && member ? <TeamSessionChat key={appId}
      appId={appId} spaceId={apps.find(app => app.id === appId)?.spaceId ?? member.spaceId ?? ''}
      teamId={detail.team.id} epochId={epochId} isRemote={member.sameMachine === false} readonly={task?.readonly || member.sameMachine === false}
      draftKey={`${detail.team.id}:${task?.workItemId ?? epochId ?? 'draft'}:${appId}`}
      ensureEpochId={epochId ? undefined : ensureEpoch} toolbarSlot={picker}

      aboveInput={reminder} renderMessages={timeline} renderAfterStreaming={thoughts => {
        const requests = decisions.filter(entry => entry.appId === appId && decisionHasReceipt(entry, thoughts))
        return requests.length ? <div className="mt-4"><TaskConversation messages={[]} activities={[]} epochId={epochId} appId={appId} detail={detail} showEmpty={false} onActivity={onActivity} decisions={requests} focusDecision={focusedDecision} onDecisionFocused={() => setFocusedDecision(null)} onAnswered={entry => { decisionHistory.answered(entry); refresh() }} /></div> : null
      }} isBackgroundTurn={isTeamBackgroundTurn}
      emptyContent={<TaskStartGuide tasks={tasks} onTask={onTask} />}
      emptyTitle={task ? t('No messages yet') : t('What would you like the team to do?')}
      emptyHint={task ? undefined : t('Send your first message to create a task. Your digital human will coordinate with the team.')}
    /> : <div className="min-h-0 flex-1 overflow-y-auto p-4">{timeline([])}<p className="mt-6 text-center text-sm text-muted-foreground">{t('Bring one of your digital humans into this team to start talking.')}</p></div>}
  </section>
}
