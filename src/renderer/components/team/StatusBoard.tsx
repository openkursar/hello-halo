/**
 * StatusBoard — Team status view, the manager's overhead view.
 *
 * A lead "hub" sits at the top; member workstations hang from a connector rail
 * below it. A connector animates while a team:message flow is active between the
 * lead and that member. A run-state banner summarizes the team at a glance, and
 * a recent-activity feed aggregates blackboard task transitions and findings.
 *
 * Responsive: below 640px the topology degrades to a vertical card list (lead
 * first) and the connector rail is hidden.
 */

import { useMemo } from 'react'
import { CheckCircle2, Undo2, AlertTriangle, CircleDot, Circle, MessageSquareText, Star, File, Send, Clock, BellOff, Flag, Hourglass } from 'lucide-react'
import type { TeamDetail, RosterMember, BlackboardTask, BlackboardFinding, TaskStatus, TeamActivity, TeamEdge, TeamStatus, EpochOutcome, TeamRunTriggerType } from '../../../shared/apps/team-types'
import { awaitsOurDecision } from '../../../shared/apps/team-types'
import type { Thought } from '../../types'
import type { ActiveFlow } from '../../stores/team.store'
import { TeamFlowCanvas } from './flow/TeamFlowCanvas'
import { StructureEditor } from './StructureEditor'
import { useTeamArtifacts } from './TeamArtifacts'
import { useChatStore } from '../../stores/chat.store'
import { buildTeamSessionKey } from '../../../shared/apps/im-keys'
import { getThoughtIcon, getToolFriendlyFormat, truncateText } from '../chat/thought-utils'
import { useTranslation } from '../../i18n'

/**
 * The one unit of work the floor renders — computed by the parent (LiveTab) from the
 * focused event. A LIVE event streams (topology pulses + live activity); a
 * REPLAY of a past run shows a static topology + that run's recorded activity
 * and products. StatusBoard is a pure renderer of this view.
 */
export interface BoardView {
  epochId: string | null
  mode: 'live' | 'replay'
  /** What the focused unit of work IS — a conversation is never "started with Run". */
  kind?: 'run' | 'conversation'
  roster: RosterMember[]
  edges: TeamEdge[]
  tasks: BlackboardTask[]
  findings: BlackboardFinding[]
  /**
   * What actually happened, in order — including the directed messages, which no
   * other list holds. Empty for runs recorded before the office kept this record;
   * the feed falls back to deriving rows from tasks/findings in that case.
   */
  activities: TeamActivity[]
  /** Present in 'live' mode — drives the live run-state banner. */
  live?: { status: TeamStatus }
  /** Present in 'replay' mode — drives the "past run" banner (time · trigger · outcome). */
  replay?: { startedAt: number; triggerType?: TeamRunTriggerType; outcome?: EpochOutcome | null; summary?: string | null }
}

interface StatusBoardProps {
  detail: TeamDetail
  board: BoardView
  activeFlows: ActiveFlow[]
  onSelectMember: (member: RosterMember) => void
  /** When true, the topology canvas becomes an in-place structure editor. */
  editingStructure?: boolean
  onExitEditing?: () => void
}

export function StatusBoard({ detail, board, activeFlows, onSelectMember, editingStructure = false, onExitEditing }: StatusBoardProps) {
  const { t } = useTranslation()

  const isLive = board.mode === 'live'

  // Editing the collaboration structure takes over the whole board area with the
  // dedicated full-canvas editor (auto-layout + draggable nodes + floating list).
  if (editingStructure) {
    return <StructureEditor detail={detail} onDone={() => onExitEditing?.()} />
  }

  if (board.roster.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {t('This team has no members yet. Add members from the manage menu.')}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5 p-3 sm:gap-6 sm:p-6">
      {/* Who the floor is waiting on. Clicking a member opens its chat, where the
          decision panel is — the one place a decision is actually answered. */}
      <PendingDecisions roster={board.roster} onSelectMember={onSelectMember} />

      {/* ── Office topology: read-only auto-laid-out canvas (React Flow + dagre).
          A replayed run shows the final org shape (no live message flows). ── */}
      <div className="h-[360px] overflow-hidden rounded-2xl bg-secondary/20 sm:h-[420px]">
        <TeamFlowCanvas
          roster={board.roster}
          edges={board.edges}
          teamId={detail.team.id}
          activeFlows={isLive ? activeFlows : []}
          onSelectMember={onSelectMember}
          focusedEpochId={board.epochId}
        />
      </div>

      {/* Live work — real-time streaming per member. Only meaningful for a live
          event; a replay's "activity" is the recorded task/finding stream below. */}
      {isLive && (
        <LiveActivityFeed
          roster={board.roster}
          teamId={detail.team.id}
          epochId={board.epochId}
          onSelectMember={onSelectMember}
        />
      )}

      <RecentActivity
        tasks={board.tasks}
        findings={board.findings}
        activities={board.activities}
        roster={board.roster}
        teamId={detail.team.id}
        epochId={board.epochId}
        kind={board.kind ?? 'run'}
        onSelectMember={onSelectMember}
        title={isLive ? undefined : t('What happened')}
        summary={board.mode === 'replay' ? board.replay?.summary ?? null : null}
      />
    </div>
  )
}

// ──────────────────────────────────────────────
// Live activity feed (real-time member work)
// ──────────────────────────────────────────────

interface LiveLine {
  appId: string
  name: string
  thought: Thought | null
  text: string
}

interface LiveActivityFeedProps {
  roster: RosterMember[]
  teamId: string
  epochId: string | null
  onSelectMember: (member: RosterMember) => void
}

/**
 * Describe what a member is doing RIGHT NOW from its latest thought, reusing the
 * same friendly tool formatter the chat thought-process uses (so "thinking" only
 * shows while actually thinking, and tool calls read as "Read path" / "Bash cmd"
 * / "Search …" instead of a permanent "thinking…").
 */
function describeThought(thought: Thought | null, t: (k: string) => string): string {
  if (!thought) return t('working…')
  switch (thought.type) {
    case 'thinking':
      return t('thinking…')
    case 'text':
      return t('writing…')
    case 'tool_use': {
      const detail = getToolFriendlyFormat(thought.toolName ?? '', thought.toolInput)
      const name = thought.toolName ?? t('a tool')
      return detail ? `${name} · ${truncateText(detail, 48)}` : name
    }
    case 'tool_result':
      return t('processing result…')
    default:
      return t('working…')
  }
}

function LiveActivityFeed({ roster, teamId, epochId, onSelectMember }: LiveActivityFeedProps) {
  const { t } = useTranslation()
  // Subscribe to the chat sessions map: it updates as members' team-channel
  // turns stream (thoughts / tool calls / text). This component re-renders on
  // those updates, but its siblings (the topology) do not.
  const sessions = useChatStore(s => s.sessions)

  const lines = useMemo<LiveLine[]>(() => {
    if (!epochId) return []
    const out: LiveLine[] = []
    for (const m of roster) {
      const sess = sessions.get(buildTeamSessionKey(m.appId, teamId, epochId)) as
        | { isGenerating?: boolean; thoughts?: Thought[] }
        | undefined
      if (!sess?.isGenerating) continue
      // The latest thought is the current action (thinking / tool / writing).
      const last = sess.thoughts && sess.thoughts.length > 0 ? sess.thoughts[sess.thoughts.length - 1] : null
      out.push({ appId: m.appId, name: m.memberName, thought: last, text: describeThought(last, t) })
    }
    return out
  }, [roster, teamId, epochId, sessions, t])

  if (lines.length === 0) return null

  const findMember = (appId: string) => roster.find(m => m.appId === appId)

  return (
    <div>
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        </span>
        {t('Working now')}
      </h3>
      <ul className="flex flex-col gap-1">
        {lines.map(l => {
          const m = findMember(l.appId)
          const Icon = getThoughtIcon(l.thought?.type ?? 'text', l.thought?.toolName)
          return (
            <li key={l.appId}>
              <button
                onClick={() => m && onSelectMember(m)}
                className="group flex w-full items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-2 text-left text-sm transition-colors hover:bg-secondary/50"
              >
                <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                <span className="flex-shrink-0 font-medium text-foreground">{l.name}</span>
                <span className="truncate text-muted-foreground">{l.text}</span>
                <span className="ml-auto flex-shrink-0 text-[11px] text-primary opacity-0 transition-opacity group-hover:opacity-100">{t('Open')}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ──────────────────────────────────────────────
// Pending decisions
// ──────────────────────────────────────────────

/**
 * Who the office is waiting on — one statement, read the same by everyone on the
 * floor. A decision belongs to exactly one person (the one whose digital human
 * raised it), and answering it lives in exactly one place: that member's panel.
 * So this states the fact and routes there; it does not offer a second way to
 * answer, and it stays in the resting palette so amber keeps meaning "yours to
 * do" — the member panel and the attention banner are where it is asked of you.
 */
function PendingDecisions({ roster, onSelectMember }: { roster: RosterMember[]; onSelectMember: (m: RosterMember) => void }) {
  const { t } = useTranslation()
  const waiting = roster.filter(m => m.status === 'waiting_user')
  if (waiting.length === 0) return null

  const unnamedOwner = t('a teammate')

  return (
    <div className="rounded-xl border border-border bg-secondary/40 px-3 py-2.5 sm:px-4">
      <div className="flex items-center gap-2">
        <Hourglass className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">{t('Waiting on a decision')}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {waiting.map(m => (
          <button
            key={m.appId}
            onClick={() => onSelectMember(m)}
            className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1 text-sm text-foreground transition-colors hover:bg-secondary"
          >
            {m.isLead && <Star className="h-3 w-3 flex-shrink-0 fill-current text-amber-500" />}
            <span className="truncate">
              {awaitsOurDecision(m)
                ? t('{{member}} is waiting on you', { member: m.memberName })
                : t('{{member}} is waiting on {{owner}}', {
                    member: m.memberName,
                    owner: m.owner || unnamedOwner,
                  })}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────
// Recent activity feed
// ──────────────────────────────────────────────

interface RecentActivityProps {
  tasks: BlackboardTask[]
  findings: BlackboardFinding[]
  activities: TeamActivity[]
  roster: RosterMember[]
  teamId: string
  epochId: string | null
  kind: 'run' | 'conversation'
  onSelectMember: (member: RosterMember) => void
  /** Section heading override (a replay says "What happened", live says "Recent activity"). */
  title?: string
  /** A past run's recorded summary — the lead paragraph above its detailed log. */
  summary?: string | null
}

/**
 * A recorded act, or — for a run that predates the office record — a row derived
 * from the tasks/findings that survived. Deriving cannot reconstruct messages or
 * a task's earlier transitions, which is precisely why the record now exists.
 */
type ActivityRow =
  | { kind: 'act'; ts: number; act: TeamActivity }
  | { kind: 'task'; ts: number; task: BlackboardTask }
  | { kind: 'task_assigned'; ts: number; task: BlackboardTask }
  | { kind: 'finding'; ts: number; finding: BlackboardFinding }

type FeedIcon = typeof CheckCircle2

/** Icon, tint, and an actor-first verb describing a task's current status. */
function taskPresentation(status: TaskStatus, t: (k: string) => string): { Icon: FeedIcon; tint: string; verb: string } {
  switch (status) {
    case 'done': return { Icon: CheckCircle2, tint: 'text-emerald-500', verb: t('completed') }
    case 'rejected': return { Icon: Undo2, tint: 'text-red-500', verb: t('needs to redo') }
    case 'blocked': return { Icon: AlertTriangle, tint: 'text-amber-500', verb: t('got stuck on') }
    case 'in_progress': return { Icon: CircleDot, tint: 'text-foreground', verb: t('is working on') }
    default: return { Icon: Circle, tint: 'text-muted-foreground/50', verb: t('was assigned') }
  }
}

/** Inline member name that opens that member's chat when its app is known. */
function ActorName({ appId, name, onSelect }: { appId: string | null; name: string; onSelect: (appId: string) => void }) {
  if (!appId) return <span className="font-medium text-foreground">{name}</span>
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={() => onSelect(appId)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(appId) } }}
      className="cursor-pointer font-medium text-foreground underline-offset-2 hover:text-primary hover:underline"
    >
      {name}
    </span>
  )
}

function RecentActivity({ tasks, findings, activities, roster, teamId, epochId, kind, onSelectMember, title, summary }: RecentActivityProps) {
  const { t } = useTranslation()

  // doneCount in the refetch key re-resolves artifacts as tasks complete.
  const doneCount = tasks.filter(tk => tk.status === 'done').length
  const { has: hasArtifact, open: openArtifact } = useTeamArtifacts(teamId, epochId, `${doneCount}:${tasks.length}`)

  const nameFor = (appId: string | null): string => {
    if (!appId) return t('Unassigned')
    return roster.find(m => m.appId === appId)?.memberName ?? appId
  }
  const selectByAppId = (appId: string): void => {
    const m = roster.find(r => r.appId === appId)
    if (m) onSelectMember(m)
  }

  const recent = useMemo<ActivityRow[]>(() => {
    if (activities.length > 0) {
      return activities
        // A 'reply' row is only written when a turn failed to run (message-bus
        // recordReply); the feed has no row form for that.
        .filter(a => a.kind !== 'reply')
        .map<ActivityRow>(act => ({ kind: 'act', ts: act.createdAt, act }))
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 15)
    }
    // A run recorded before the office kept this record: reconstruct what can be
    // reconstructed from the state that survived.
    const rows: ActivityRow[] = []
    for (const task of tasks) {
      rows.push({ kind: 'task', ts: task.updatedAt, task })
      // For tasks that have progressed past pending, also surface the
      // original assignment so the delegation context is never lost.
      if (task.status !== 'pending' && task.createdAt !== task.updatedAt) {
        rows.push({ kind: 'task_assigned', ts: task.createdAt, task })
      }
    }
    for (const finding of findings) {
      rows.push({ kind: 'finding', ts: finding.createdAt, finding })
    }
    return rows.sort((a, b) => b.ts - a.ts).slice(0, 15)
  }, [activities, tasks, findings])

  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title ?? t('Recent activity')}
      </h3>
      {summary && (
        <p className="mb-3 text-sm leading-relaxed text-foreground/90">
          {summary}
        </p>
      )}
      {recent.length === 0 ? (
        summary ? null : (
          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground/70">
            {kind === 'conversation'
              // The board is what the team WRITES DOWN; a conversation can be
              // answered without writing anything down, so an empty board here
              // is a normal outcome, not a "you have not started yet".
              ? t('Nothing recorded on the board in this conversation.')
              : t('No activity yet. Run the team to get started.')}
          </p>
        )
      ) : (
        <ul className="flex flex-col gap-1">
          {recent.map(row => {
            if (row.kind === 'act') {
              return (
                <ActRow
                  key={row.act.id}
                  act={row.act}
                  nameFor={nameFor}
                  onSelect={selectByAppId}
                  taskTitleFor={taskId => tasks.find(tk => tk.id === taskId)?.title ?? null}
                />
              )
            }
            if (row.kind === 'task_assigned') {
              const task = row.task
              return (
                <li key={`assigned-${task.id}`} className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-secondary/40">
                  <Circle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/50" />
                  <span className="min-w-0 flex-1 truncate">
                    <ActorName appId={task.assigneeAppId} name={nameFor(task.assigneeAppId)} onSelect={selectByAppId} />
                    <span className="text-muted-foreground"> {t('was assigned')} </span>
                    <span className="text-foreground/80">{task.title}</span>
                  </span>
                  <span className="flex-shrink-0 text-[11px] text-muted-foreground/60">{relativeTime(task.createdAt, t)}</span>
                </li>
              )
            }
            if (row.kind === 'finding') {
              const f = row.finding
              const author = roster.find(r => r.appId === f.authorAppId)
              const FindingIcon = author?.isLead ? Star : MessageSquareText
              const tint = author?.isLead ? 'text-amber-500' : 'text-muted-foreground/70'
              return (
                <li key={`finding-${f.id}`} className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-secondary/40">
                  <FindingIcon className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${tint}`} fill={author?.isLead ? 'currentColor' : 'none'} />
                  <span className="line-clamp-2 min-w-0 flex-1">
                    <ActorName appId={f.authorAppId} name={nameFor(f.authorAppId)} onSelect={selectByAppId} />
                    <span className="text-muted-foreground">: {f.body || f.ref}</span>
                  </span>
                  <span className="flex-shrink-0 text-[11px] text-muted-foreground/60">{relativeTime(f.createdAt, t)}</span>
                </li>
              )
            }
            const task = row.task
            const { Icon, tint, verb } = taskPresentation(task.status, t)
            return (
              <li key={`${task.id}-${task.updatedAt}`} className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-secondary/40">
                <Icon className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${tint}`} />
                <span className="min-w-0 flex-1 truncate">
                  <ActorName appId={task.assigneeAppId} name={nameFor(task.assigneeAppId)} onSelect={selectByAppId} />
                  <span className="text-muted-foreground"> {verb} </span>
                  <span className="text-foreground/80">{task.title}</span>
                  {task.resultRef && (
                    hasArtifact(task.resultRef) ? (
                      <button
                        type="button"
                        onClick={() => openArtifact(task.resultRef!)}
                        title={t('Open with the default app')}
                        className="ml-1.5 inline-flex items-center gap-0.5 font-mono text-xs text-primary underline-offset-2 hover:underline"
                      >
                        <File className="inline h-3 w-3" />
                        {task.resultRef.split('/').pop() ?? task.resultRef}
                      </button>
                    ) : (
                      <span className="ml-1.5 inline-flex items-center gap-0.5 font-mono text-xs text-muted-foreground" title={task.resultRef}>
                        <File className="inline h-3 w-3" />
                        {task.resultRef.split('/').pop() ?? task.resultRef}
                      </span>
                    )
                  )}
                </span>
                <span className="flex-shrink-0 text-[11px] text-muted-foreground/60">{relativeTime(task.updatedAt, t)}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

interface ActRowProps {
  act: TeamActivity
  nameFor: (appId: string | null) => string
  onSelect: (appId: string) => void
  taskTitleFor: (taskId: string) => string | null
}

/**
 * One recorded act. The main side stores only the CONTENT (a task title, a
 * message's first line) and the kind; the sentence around it is composed here so
 * it reads in the user's language.
 */
function ActRow({ act, nameFor, onSelect, taskTitleFor }: ActRowProps) {
  const { t } = useTranslation()

  const actor = <ActorName appId={act.actorAppId} name={nameFor(act.actorAppId)} onSelect={onSelect} />
  const target = act.targetAppId
    ? <ActorName appId={act.targetAppId} name={nameFor(act.targetAppId)} onSelect={onSelect} />
    : null

  let Icon: FeedIcon = Circle
  let tint = 'text-muted-foreground/50'
  let middle: React.ReactNode = null
  // Only a message that never arrived earns a label. Answered-ness is not one:
  // the record cannot tell a question from a notice, and a reply is a message of
  // its own, already in the feed a row below.
  let state: string | null = null

  switch (act.kind) {
    case 'message':
      Icon = Send
      tint = 'text-foreground/60'
      middle = <><span className="text-muted-foreground"> {t('messaged')} </span>{target}<span className="text-muted-foreground">: </span><span className="text-foreground/80">{act.subject}</span></>
      state = act.status === 'undelivered' ? t('not delivered') : null
      break
    case 'task_post':
      Icon = Circle
      middle = <><span className="text-muted-foreground"> {t('assigned')} </span><span className="text-foreground/80">{act.subject}</span><span className="text-muted-foreground"> {t('to')} </span>{target}</>
      break
    case 'task_update': {
      const p = taskPresentation((act.status as TaskStatus) ?? 'pending', t)
      Icon = p.Icon
      tint = p.tint
      const title = act.refId ? taskTitleFor(act.refId) : null
      middle = <><span className="text-muted-foreground"> {p.verb} </span><span className="text-foreground/80">{title ?? act.subject}</span></>
      break
    }
    case 'finding':
      Icon = MessageSquareText
      tint = 'text-muted-foreground/70'
      middle = <><span className="text-muted-foreground"> {t('shared')} </span><span className="text-foreground/80">{act.subject}</span></>
      break
    case 'check_set':
      Icon = Clock
      tint = 'text-sky-500'
      middle = <><span className="text-muted-foreground"> {t('set a recurring check on')} </span>{target}<span className="text-muted-foreground">: </span><span className="text-foreground/80">{act.subject}</span></>
      break
    case 'check_stop':
      Icon = BellOff
      tint = 'text-muted-foreground/70'
      middle = <><span className="text-muted-foreground"> {t('stopped a recurring check on')} </span>{target}</>
      break
    case 'run_end':
      Icon = Flag
      tint = 'text-emerald-500'
      middle = <><span className="text-muted-foreground"> {t('ended the run')} </span><span className="text-foreground/80">{act.subject}</span></>
      break
    default:
      return null
  }

  return (
    <li className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-secondary/40">
      <Icon className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${tint}`} />
      <span className="min-w-0 flex-1 truncate">
        {actor}
        {middle}
      </span>
      {state && (
        <span className="hidden flex-shrink-0 text-[11px] text-muted-foreground/60 sm:inline">{state}</span>
      )}
      <span className="flex-shrink-0 text-[11px] text-muted-foreground/60">{relativeTime(act.createdAt, t)}</span>
    </li>
  )
}

/** Compact relative time for activity rows. */
function relativeTime(ts: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return t('just now')
  if (m < 60) return t('{{count}}m', { count: m })
  const h = Math.floor(m / 60)
  if (h < 24) return t('{{count}}h', { count: h })
  const d = Math.floor(h / 24)
  return t('{{count}}d', { count: d })
}
