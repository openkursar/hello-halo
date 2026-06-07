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
import { Play, CheckCircle2, Undo2, AlertTriangle, CircleDot, Circle, MessageSquareText, Star, File } from 'lucide-react'
import type { TeamDetail, RosterMember, BlackboardTask, BlackboardFinding, TaskStatus } from '../../../shared/apps/team-types'
import type { Thought } from '../../types'
import type { ActiveFlow } from '../../stores/team.store'
import { TeamFlowCanvas } from './flow/TeamFlowCanvas'
import { StructureEditor } from './StructureEditor'
import { useTeamArtifacts } from './TeamArtifacts'
import { useChatStore } from '../../stores/chat.store'
import { buildTeamSessionKey } from '../../../shared/apps/im-keys'
import { getThoughtIcon, getToolFriendlyFormat, truncateText } from '../chat/thought-utils'
import { useTranslation } from '../../i18n'

interface StatusBoardProps {
  detail: TeamDetail
  activeFlows: ActiveFlow[]
  onSelectMember: (member: RosterMember) => void
  /** When true, the topology canvas becomes an in-place structure editor. */
  editingStructure?: boolean
  onExitEditing?: () => void
}

export function StatusBoard({ detail, activeFlows, onSelectMember, editingStructure = false, onExitEditing }: StatusBoardProps) {
  const { t } = useTranslation()

  const members = useMemo(() => detail.roster.filter(m => !m.isLead), [detail.roster])

  // Editing the collaboration structure takes over the whole board area with the
  // dedicated full-canvas editor (auto-layout + draggable nodes + floating list).
  if (editingStructure) {
    return <StructureEditor detail={detail} onDone={() => onExitEditing?.()} />
  }

  if (detail.roster.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {t('This team has no members yet. Add members from the manage menu.')}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5 p-3 sm:gap-6 sm:p-6">
      <RunBanner status={detail.team.status} members={members.length} />

      {/* Escalations awaiting the user — prominent and actionable (click a member
          to open its chat, where the decision panel is shown inline). */}
      <EscalationCallout roster={detail.roster} onSelectMember={onSelectMember} />

      {/* ── Office topology: read-only auto-laid-out canvas (React Flow + dagre) ── */}
      <div className="h-[300px] overflow-hidden rounded-2xl border border-border bg-gradient-to-b from-secondary/20 to-transparent sm:h-[360px]">
        <TeamFlowCanvas
          roster={detail.roster}
          edges={detail.edges}
          teamId={detail.team.id}
          activeFlows={activeFlows}
          onSelectMember={onSelectMember}
        />
      </div>

      {/* Live work — what each member is doing right now (isolated so token
          updates don't re-render the topology). */}
      <LiveActivityFeed
        roster={detail.roster}
        teamId={detail.team.id}
        epochId={detail.team.currentEpochId}
        onSelectMember={onSelectMember}
      />

      <RecentActivity
        tasks={detail.tasks}
        findings={detail.findings}
        roster={detail.roster}
        teamId={detail.team.id}
        epochId={detail.team.currentEpochId}
        onSelectMember={onSelectMember}
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
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
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
// Escalation callout (members awaiting the user's decision)
// ──────────────────────────────────────────────

function EscalationCallout({ roster, onSelectMember }: { roster: RosterMember[]; onSelectMember: (m: RosterMember) => void }) {
  const { t } = useTranslation()
  const waiting = roster.filter(m => m.status === 'waiting_user')
  if (waiting.length === 0) return null

  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 sm:px-4">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 flex-shrink-0 text-amber-500" />
        <span className="text-sm font-medium text-foreground">{t('Waiting for your decision')}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {waiting.map(m => (
          <button
            key={m.appId}
            onClick={() => onSelectMember(m)}
            className="inline-flex items-center gap-1 rounded-lg border border-amber-500/40 bg-background px-2.5 py-1 text-sm text-foreground transition-colors hover:bg-amber-500/10"
          >
            {m.isLead && <Star className="h-3 w-3 fill-current text-amber-500" />}
            {m.memberName}
            <span className="text-xs text-amber-600 dark:text-amber-400">{t('Respond')}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────
// Run-state banner
// ──────────────────────────────────────────────

function RunBanner({ status, members }: { status: TeamDetail['team']['status']; members: number }) {
  const { t } = useTranslation()

  const config: Record<string, { dot: string; label: string; hint: string }> = {
    running: {
      dot: 'bg-emerald-500',
      label: t('Running'),
      hint: t('The lead is coordinating the team.'),
    },
    waiting_user: {
      dot: 'bg-amber-500',
      label: t('Waiting for you'),
      hint: t('A member needs your decision.'),
    },
    error: {
      dot: 'bg-red-500',
      label: t('Stopped'),
      hint: t('The run hit a problem.'),
    },
    idle: {
      dot: 'bg-muted-foreground/40',
      label: t('Idle'),
      hint: t('Press Run to start a coordinated session.'),
    },
  }
  const c = config[status] ?? config.idle

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-secondary/30 px-3 py-2.5 sm:px-4">
      <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
        {status === 'running' && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
        )}
        <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${c.dot}`} />
      </span>
      <div className="min-w-0 flex-1">
        <span className="text-sm font-medium text-foreground">{c.label}</span>
        <span className="ml-2 text-xs text-muted-foreground">{c.hint}</span>
      </div>
      {status === 'idle' && (
        <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
          <Play className="h-3 w-3" />
          {t('{{count}} members ready', { count: members })}
        </span>
      )}
    </div>
  )
}

// ──────────────────────────────────────────────
// Recent activity feed
// ──────────────────────────────────────────────

interface RecentActivityProps {
  tasks: BlackboardTask[]
  findings: BlackboardFinding[]
  roster: RosterMember[]
  teamId: string
  epochId: string | null
  onSelectMember: (member: RosterMember) => void
}

/** A task transition or a posted finding, unified for the activity feed. */
type ActivityRow =
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

function RecentActivity({ tasks, findings, roster, teamId, epochId, onSelectMember }: RecentActivityProps) {
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

  // Tasks (by last transition) and findings (by post time) share one
  // time-ordered stream, so the feed reflects everything written to the board
  // for this run — not just task status changes.
  const recent = useMemo<ActivityRow[]>(() => {
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
  }, [tasks, findings])

  return (
    <div>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t('Recent activity')}
      </h3>
      {recent.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground/70">
          {t('No activity yet. Run the team to get started.')}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {recent.map(row => {
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
