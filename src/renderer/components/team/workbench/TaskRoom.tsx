import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Activity, AlertCircle, ArrowLeft, ArrowRight, Pencil, Check, X } from 'lucide-react'
import type { RosterMember, TeamConversation, TeamDetail } from '../../../../shared/apps/team-types'
import { parseSpaceCoordinatorAppId } from '../../../../shared/apps/team-types'
import { buildTeamSessionKey } from '../../../../shared/apps/im-keys'
import { useMemberPresence, useTeamStore } from '../../../stores/team.store'
import { useAppsStore } from '../../../stores/apps.store'
import { useChatStore } from '../../../stores/chat.store'
import { useTeamViewPrefsStore } from '../../../stores/team-view-prefs.store'
import { useTranslation } from '../../../i18n'
import { TeamSessionChat } from '../TeamSessionChat'
import { useTaskDecisions } from './useTaskDecisions'
import { decisionHasReceipt, isTeamBackgroundTurn } from './model'
import type { TaskBoardState } from './useTaskBoard'
import { TaskConversation } from './TaskConversation'
import { ExecutionStatus } from './ExecutionStatus'
import { TaskStartGuide } from './TaskStartGuide'
import { TaskMemberSelector } from './TaskMemberSelector'
import { useTaskProgress } from './useTaskProgress'
import { AutomationAvatar } from '../../apps/AutomationAvatar'
import { ownedTaskMembers } from './members'
import { navigateToConversation } from '../../../utils/conversation-navigation'
import { ConversationReferenceScope } from '../../references'

export function TaskRoom({ detail, task, selectedAppId, onSelectMember, onCreated, onActivity, boardState, decisionTarget, tasks, onTask, onExecution, blocked = false, homepageConversation = false, returnToMain, viewOnly }: {
  blocked?: boolean; homepageConversation?: boolean
  /** A temporary team's member, watched from inside the conversation that leads the team: nobody else may message it. */
  returnToMain?: () => void
  /**
   * Watched from the Teams page, where nothing is sent: the composer stays locked with `reason`
   * and `action`, and `header` leads the record.
   */
  viewOnly?: { header?: ReactNode; reason?: string; action?: ReactNode }
  detail: TeamDetail; task: TeamConversation | null; selectedAppId: string | null; onSelectMember: (member: RosterMember) => void
  onCreated: (id: string) => void; onActivity: (activityId?: string) => void; boardState: TaskBoardState; decisionTarget?: string; tasks: TeamConversation[]; onTask: (id: string, decisionEntry?: boolean) => void; onExecution: (appId: string) => void
}) {
  const { t } = useTranslation()
  const apps = useAppsStore(s => s.apps)
  const own = useMemo(() => ownedTaskMembers(detail, apps), [detail, apps])
  const ids = useMemo(() => own.map(m => m.appId), [own])
  const setDefault = useTeamViewPrefsStore(s => s.setDefaultMember)
  const appId = selectedAppId && !parseSpaceCoordinatorAppId(selectedAppId) ? selectedAppId : null
  const member = detail.roster.find(m => m.appId === appId)
  // Another person's member: what is said to it in its chat is said by its owner.
  const authorName = member?.sameMachine === false ? member.owner ?? undefined : undefined
  const presence = useMemberPresence(detail.team.id, appId ?? '')
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
  const focusDecision = (entry: (typeof pending)[number]) => {
    if (ids.includes(entry.appId)) {
      setDefault(detail.team.id, entry.appId)
      const target = detail.roster.find(item => item.appId === entry.appId)
      if (target) onSelectMember(target)
    }
    setFocusedDecision(entry.id)
  }
  const progress = useTaskProgress({ detail, task: homepageConversation ? task : null, boardState, decisions: pending.filter(entry => ids.includes(entry.appId)) })
  // A homepage conversation flags waiting members on its member rail instead.
  const reminder = !homepageConversation && pending.length > 0 && <button onClick={() => focusDecision(pending.find(item => item.appId === appId) ?? pending[0])} className="mb-2 flex min-h-10 w-full items-center gap-2 rounded-lg border border-halo-warning/30 bg-halo-warning/5 px-3 py-2 text-left text-xs text-halo-warning focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
    <AlertCircle size={15} className="shrink-0" /><span className="min-w-0 flex-1">{t('{{count}} decisions need your answer', { count: pending.length })}</span><span>{t('View')}</span><ArrowRight size={14} />
  </button>
  const entryAppId = appId && ids.includes(appId) ? appId : undefined
  const ensureEpoch = useCallback((firstMessage: string) => {
    if (!creating.current) creating.current = openConversation(detail.team.id, Array.from(firstMessage.trim().replace(/\s+/g, ' ')).slice(0, 60).join('') || undefined, entryAppId).then(id => {
      if (id) onCreated(id)
      return id
    }).finally(() => { creating.current = null })
    return creating.current
  }, [detail.team.id, openConversation, onCreated, entryAppId])
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
    {lastConversation && lastConversation.epochId === epochId && lastConversation.appId !== appId && <button onClick={() => {
      const target = detail.roster.find(item => item.appId === lastConversation.appId)
      if (target) onSelectMember(target)
    }} className="block min-h-8 rounded text-left text-xs text-primary hover:underline">{t('Return to your conversation with {{name}}', { name: detail.roster.find(item => item.appId === lastConversation.appId)?.memberName ?? t('Former member') })} →</button>}
    {otherDecisions.slice(0, 2).map(entry => <button key={entry.entryId} onClick={() => onTask(entry.epochId!, true)} className="block min-h-8 rounded text-left text-xs text-halo-warning hover:underline">{homepageConversation ? t('Needs your answer in {{name}}', { name: tasks.find(item => item.epochId === entry.epochId)?.label ?? t('Another conversation') }) : t('Needs your answer in {{task}}', { task: tasks.find(item => item.epochId === entry.epochId)?.label ?? t('Another task') })} →</button>)}
  </div>
  const busy = !!member?.busy?.some(row => row.epochId === epochId)
  const generating = useChatStore(s => !!appId && !!epochId && s.getSession(buildTeamSessionKey(appId, detail.team.id, epochId)).isGenerating)
  const execution = (messages: import('../../../types').Message[], senderShown = false) => epochId && member && appId && isTeamBackgroundTurn(messages) && <ExecutionStatus teamId={detail.team.id} epochId={epochId} appId={appId} remote={member.sameMachine === false} busy={busy}
    latestResult={homepageConversation ? undefined : [...messages].reverse().find(message => message.role === 'assistant')} onOpen={() => onExecution(appId)} asReply={homepageConversation} senderName={senderShown ? undefined : member.memberName} />
  const [revealActivity, setRevealActivity] = useState<{ appId: string; activityId: string } | null>(null)
  const clearReveal = useCallback(() => setRevealActivity(null), [])
  const openMember = (targetAppId: string, activityId: string) => {
    const target = detail.roster.find(item => item.appId === targetAppId)
    if (!target) return
    setRevealActivity({ appId: targetAppId, activityId })
    onSelectMember(target)
  }
  const timeline = (messages: import('../../../types').Message[], liveThoughts: import('../../../types').Thought[] = [], endingShownBelow?: string) => <>
    <TaskConversation liveReply={homepageConversation ? senderShown => execution(messages, senderShown) : undefined}
      onOpenMember={homepageConversation ? openMember : undefined} revealActivity={revealActivity?.appId === appId ? revealActivity.activityId : null} onActivityRevealed={clearReveal} homepageConversation={homepageConversation} authorName={authorName} endingShownBelow={endingShownBelow} readonly={blocked || !!returnToMain || !!viewOnly || !!task?.readonly || !appId || !ids.includes(appId)} messages={messages} activities={boardState.activities} epochId={epochId} appId={appId ?? undefined} detail={detail} showEmpty={!!appId && !!epochId && !boardState.failed && !!boardState.board} working={busy || generating} onActivity={onActivity}
      taskCompleted={!!task?.completed} emptyActions={emptyActions} onHumanConversation={rememberConversation} focusDecision={focusedDecision} onDecisionFocused={() => setFocusedDecision(null)} decisions={decisions.filter(entry => (entry.appId === appId || !ids.includes(entry.appId)) && !decisionHasReceipt(entry, liveThoughts))} onAnswered={entry => { decisionHistory.answered(entry); refresh() }} />
    {!homepageConversation && execution(messages)}
  </>
  const memberLabel = member ? <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={member.memberName}>
    <span className="shrink-0"><AutomationAvatar name={member.memberName} size={20} /></span><span className="max-w-32 truncate sm:max-w-48">{member.memberName}</span>
  </span> : undefined
  const workbenchPicker = member && !task?.readonly && ids.includes(member.appId) && own.length > 1 ? <label className="flex min-w-0 items-center gap-1.5 rounded-lg border border-border bg-background pl-1.5 text-xs">
    <span className="shrink-0"><AutomationAvatar name={member.memberName} size={20} /></span>
    <select aria-label={t('Choose who to talk to')} title={member.memberName} value={appId ?? ''} onChange={event => {
      setDefault(detail.team.id, event.target.value)
      const target = detail.roster.find(item => item.appId === event.target.value)
      if (target) onSelectMember(target)
    }} className="min-w-0 max-w-36 truncate rounded-lg bg-background py-1.5 pl-0.5 pr-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:max-w-48">
      {own.map(m => <option key={m.appId} value={m.appId}>{m.memberName}</option>)}
    </select>
  </label> : memberLabel
  const waitingAppIds = new Set(pending.map(entry => entry.appId))
  const workingAppIds = new Set(epochId ? detail.roster.filter(item => item.busy?.some(row => row.epochId === epochId)).map(item => item.appId) : [])
  const conversationProgress = progress && task ? {
    progress, leadAppId: detail.team.leadAppId ?? null, outputCount: task.artifactCount ?? 0,
    onAnswer: (id: string) => { const entry = pending.find(item => item.id === id); if (entry) focusDecision(entry) },
  } : null
  const talkTo = homepageConversation && appId && !ids.includes(appId) && !blocked && !returnToMain && !task?.readonly
    ? detail.roster.find(item => item.appId === detail.team.leadAppId && ids.includes(item.appId)) ?? detail.roster.find(item => ids.includes(item.appId))
    : undefined
  const picker = homepageConversation ? <div className="min-w-0 pt-1">
    <TaskMemberSelector roster={detail.roster} selectedAppId={appId} ownedAppIds={ids} waitingAppIds={waitingAppIds} workingAppIds={workingAppIds} progress={conversationProgress} onActivity={task ? onActivity : undefined} onSelect={onSelectMember}
      onAnswer={id => { const entry = pending.find(item => item.appId === id); if (entry) focusDecision(entry) }}
      temporary={!!returnToMain} />
  </div> : workbenchPicker
  const viewOnlyReason = viewOnly && (viewOnly.reason ?? t('Viewing only. Continue this conversation on the homepage.'))
  return <section className="flex h-full min-h-0 min-w-0 flex-col" aria-label={homepageConversation ? t('Conversation') : t('Task room')}>
    {!homepageConversation && <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border px-4 py-2">
      {renaming ? <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={event => { event.preventDefault(); void saveTitle() }}>
        <input autoFocus aria-label={t('Task title')} maxLength={200} value={title} onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setRenaming(false); setRenameError(false) } }} className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm" />
        <button disabled={saving || !title.trim()} className="rounded-lg p-2 text-primary hover:bg-primary/5 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" aria-label={t('Save')}><Check size={16} /></button><button type="button" onClick={() => { setRenaming(false); setRenameError(false) }} className="rounded-lg p-2 text-muted-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" aria-label={t('Cancel')}><X size={16} /></button>
      </form> : <><h2 title={task?.label} className="min-w-0 flex-1 truncate text-sm font-medium">{task?.label || t('New task')}</h2>
        {task && <button onClick={() => { setTitle(task.label); setRenameError(false); setRenaming(true) }} aria-label={t('Rename task')} className="rounded-lg p-2 text-muted-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><Pencil size={14} /></button>}</>}
      {task?.completed && <span className="text-xs text-muted-foreground">{t('Completed')}</span>}
      {task && <button onClick={() => onActivity()} className={`flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1.5 text-xs ${pending.length ? 'border-halo-warning/30 text-halo-warning' : task.active ? 'border-primary/30 text-primary' : 'border-border text-muted-foreground'}`}><Activity size={14} />{t('Task activity')}{pending.length > 0 && <span>{pending.length}</span>}</button>}
    </header>}
    {task?.kind === 'collab' && !returnToMain && <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2 text-xs text-muted-foreground">
      <span>{t('Main chat')}</span>
      {task.sourceConversation && <button onClick={() => navigateToConversation(task.sourceConversation!.spaceId, task.sourceConversation!.conversationId)} className="min-h-8 rounded text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('Return to conversation')} →</button>}
    </div>}
    {boardState.failed && <p role="alert" className="px-4 py-2 text-xs text-halo-warning">{t('Could not load collaboration updates.')} <button className="underline" onClick={boardState.retry}>{t('Retry')}</button></p>}
    {decisionHistory.failed && <p role="alert" className="px-4 py-2 text-xs text-halo-warning">{t('Could not load decision history.')} <button onClick={decisionHistory.retry} className="underline">{t('Retry')}</button></p>}
    {renameError && <p role="alert" className="p-2 text-xs text-destructive">{t('Could not rename this task. Please try again.')}</p>}
    {task?.readonly && task.kind === 'im' && !viewOnly && <p className="shrink-0 border-b border-border px-4 py-2 text-xs text-muted-foreground">{t('External conversation is read-only. Internal decisions can be answered here.')}</p>}
    {(task?.readonly || !appId) && <div className="shrink-0 px-3">{reminder}</div>}
    {appId && member ? <ConversationReferenceScope conversationId={homepageConversation && epochId ? buildTeamSessionKey(appId, detail.team.id, epochId) : null} conversationTitle={task?.label ?? ''} spaceId={null}><TeamSessionChat key={appId}
      appId={appId} spaceId={apps.find(app => app.id === appId)?.spaceId ?? member.spaceId ?? ''}
      teamId={detail.team.id} epochId={epochId} isRemote={member.sameMachine === false} ownerName={member.owner ?? presence.ownerName} reachability={presence.reachability} readonly={blocked || !!returnToMain || !!viewOnly || task?.readonly || !ids.includes(appId)}
      readonlyMessage={returnToMain ? t('Temporary team members can’t be messaged directly. To change their work, tell the main chat.') : viewOnly?.reason ? viewOnly.reason : member.sameMachine === false
        ? talkTo ? member.owner ? t('{{name}} is {{owner}}’s digital human. To ask it something, tell {{via}}.', { name: member.memberName, owner: member.owner, via: talkTo.memberName }) : t('{{name}} is a teammate’s digital human. To ask it something, tell {{via}}.', { name: member.memberName, via: talkTo.memberName })
        : member.owner ? t('Viewing {{name}}’s work. Only {{owner}} can send messages.', { name: member.memberName, owner: member.owner }) : t('Viewing this teammate’s digital human. Only its owner can send messages.')
        : viewOnlyReason || (homepageConversation ? t('This conversation is read-only.') : t('This task is read-only.'))}
      readonlyAction={returnToMain ? <button type="button" onClick={returnToMain} className="inline-flex min-h-8 items-center gap-1 rounded-md px-1.5 text-xs text-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><ArrowLeft size={13} aria-hidden="true" />{t('Back to main chat')}</button>
        : viewOnly ? viewOnly.action : talkTo && <button type="button" onClick={() => onSelectMember(talkTo)} className="inline-flex min-h-8 items-center gap-1 rounded-md px-1.5 text-xs text-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('Talk to {{name}}', { name: talkTo.memberName })}<ArrowRight size={13} aria-hidden="true" /></button>}
      draftKey={`${detail.team.id}:${task?.workItemId ?? epochId ?? 'draft'}:${appId}`}
      ensureEpochId={epochId ? undefined : ensureEpoch} toolbarSlot={homepageConversation ? undefined : picker} composerAdjacentSlot={homepageConversation ? picker : undefined}
      topSlot={viewOnly?.header} senderName={homepageConversation ? member.memberName : undefined}
      authorName={authorName}
      placeholder={homepageConversation ? t('Message {{name}}…', { name: member.memberName }) : undefined}
      aboveInput={reminder} renderMessages={timeline}
      renderAfterStreaming={thoughts => {
        const requests = decisions.filter(entry => entry.appId === appId && decisionHasReceipt(entry, thoughts))
        return requests.length ? <div className="mt-4"><TaskConversation messages={[]} activities={[]} epochId={epochId} appId={appId} detail={detail} showEmpty={false} onActivity={onActivity} decisions={requests} focusDecision={focusedDecision} onDecisionFocused={() => setFocusedDecision(null)} onAnswered={entry => { decisionHistory.answered(entry); refresh() }} /></div> : null
      }} isBackgroundTurn={isTeamBackgroundTurn}
      emptyContent={homepageConversation ? undefined : <TaskStartGuide tasks={tasks} onTask={onTask} />}
      emptyTitle={homepageConversation || task ? t('No messages yet') : t('What would you like the team to do?')}
      emptyHint={homepageConversation || task ? undefined : t('Send your first message to create a task. Your digital human will coordinate with the team.')}
    /></ConversationReferenceScope> : <><div className="min-h-0 flex-1 overflow-y-auto p-4">{viewOnly?.header}{timeline([])}<p className="mt-6 text-center text-sm text-muted-foreground">{task && !boardState.board && !boardState.failed ? t('Loading task…') : t('Bring one of your digital humans into this team to start talking.')}</p></div>{homepageConversation && !viewOnly && <div className="shrink-0 px-6 pb-[18px]"><div className="mx-auto max-w-chat">{picker}</div></div>}</>}
  </section>
}
