/**
 * WorkHistory - how a reply's work reads, while it runs and after it ends.
 *
 * Folded to one line above the reply. Opened, it is a timeline: what the AI
 * said along the way, records it received, notable steps on lines of their
 * own, and between them each stretch of operations as one summary line that
 * opens to its steps. The task plan follows. The words shown under the work
 * (the answer, or what the reply is still writing) are never repeated in it.
 * The live and saved owners (ThoughtProcess, CollapsedThoughtProcess) keep the
 * state; every visual detail lives here, so the two cannot drift apart.
 */

import { memo, useId, useMemo, useRef, useState } from 'react'
import { ListCollapse, Users } from 'lucide-react'
import { TodoCard } from '../../tool/TodoCard'
import type { TodoItem } from '../../../utils/thought-activity'
import { MarkdownRenderer } from '../MarkdownRenderer'
import { ArrivalCard } from '../ArrivalCard'
import { SkillNotice } from '../SkillNotice'
import { readTeamProvenance } from '../team-collab'
import { workSeconds, type ArrivalThought } from '../transcript'
import { getThoughtIcon, type ThoughtPanelModel } from '../thought-utils'
import { useFileLinkOptions } from '../../references'
import { PROCESS_CUE, PROCESS_LINE } from '../process-line'
import { OperationGroup } from './OperationGroup'
import { OperationRow } from './OperationRow'
import { WorkHistoryHeader } from './WorkHistoryHeader'
import { formatWorkDuration } from './duration'
import { answerTextIds } from './spoken-text'
import { hasWorkToShow, nextWorkStream, type WorkEntry, type WorkStream } from './work-stream'
import { WorkViewScope, type WorkViewState } from './view-memory'
import type { Thought } from '../../../types'
import { getCurrentLanguage, useTranslation } from '../../../i18n'

/** Timeline entries drawn at first; earlier ones come in pages of the same size. */
export const TIMELINE_PAGE = 200

interface WorkHistoryProps {
  model: ThoughtPanelModel
  todos: TodoItem[] | null
  /** The reply is still running. */
  live: boolean
  /** What the reply is doing now, its title while it runs. */
  activity?: string
  /** The saved reply's answer, shown below the work. */
  answer?: string
  /** Text steps a running reply shows below the work as its latest words. */
  liveTextIds?: ReadonlySet<string>
  open: boolean
  onToggle?: () => void
  /** Every stretch of operations open from the start, as trace views want them. */
  showOperations?: boolean
  /** Inside a host that frames and titles the turn: no header, always open. */
  embedded?: boolean
  /** Where the stretches and steps opened inside are remembered. */
  view?: WorkViewState | null
  className?: string
}

const SpokenWords = memo(function SpokenWords({ content }: { content: string }) {
  return (
    <div className="break-words leading-relaxed text-muted-foreground">
      <MarkdownRenderer content={content} />
    </div>
  )
})

function arrivalSender(thought: ArrivalThought): string {
  const team = readTeamProvenance(thought.arrival)
  return team?.fromMemberName || team?.teamName || thought.arrival.metadata?.fromConversationTitle || ''
}

/** Records received in a row: a line each, or one line naming who sent them when there are several. */
const ReceivedRecords = memo(function ReceivedRecords({ thoughts }: { thoughts: readonly ArrivalThought[] }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const card = (thought: ArrivalThought) => <ArrivalCard key={thought.id} message={thought.arrival} inProcess />
  if (thoughts.length === 1) return card(thoughts[0])
  const senders = [...new Set(thoughts.map(arrivalSender).filter(Boolean))]
  const names = new Intl.ListFormat(getCurrentLanguage(), { style: 'long', type: 'conjunction' }).format(senders)
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={PROCESS_LINE}
      >
        <Users size={14} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 truncate text-[13px] text-muted-foreground">
          {senders.length > 0 ? t('{{names}} sent {{count}} messages', { names, count: thoughts.length }) : t('Received {{count}} messages', { count: thoughts.length })}
        </span>
        <span aria-hidden="true" className={PROCESS_CUE}>{open ? t('Collapse') : t('Expand')}</span>
      </button>
      {open && <div className="mb-1.5 ml-[7px] mt-px border-l border-border-soft pl-2.5">{thoughts.map(card)}</div>}
    </div>
  )
})

/** The session notice ("Connected | Model: …"): the work's first line, as it always read, with nothing to open. */
function NoticeLine({ thought }: { thought: Thought }) {
  const { t } = useTranslation()
  const Icon = getThoughtIcon(thought.type)
  return (
    <div className="flex min-h-[31px] min-w-0 items-center gap-2 py-[3px] text-xs text-faint-foreground">
      <Icon size={14} aria-hidden="true" className="shrink-0" />
      <span className="shrink-0">{t('System')}</span>
      <span className="min-w-0 truncate text-[13px] text-muted-foreground">{thought.content}</span>
    </div>
  )
}

/** Where the engine compacted the context: a milestone, nothing to open. */
function CompactionLine({ thought }: { thought: Thought }) {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-[31px] items-center gap-2 py-[3px] text-xs text-faint-foreground">
      <ListCollapse size={14} aria-hidden="true" className="shrink-0" />
      <span className="text-[13px] text-muted-foreground">
        {thought.compaction?.trigger === 'manual' ? t('Context compacted') : t('Context compacted automatically')}
      </span>
    </div>
  )
}

interface TimelineProps {
  entries: readonly WorkEntry[]
  live: boolean
  childGroups: ReadonlyMap<string, Thought[]>
  baseDir?: string
  showOperations: boolean
}

function Timeline({ entries, live, childGroups, baseDir, showOperations }: TimelineProps) {
  const { t } = useTranslation()
  const [shown, setShown] = useState(TIMELINE_PAGE)
  const hidden = Math.max(0, entries.length - shown)
  const visible = hidden > 0 ? entries.slice(hidden) : entries
  return (
    <div className="space-y-1.5">
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShown(shown + TIMELINE_PAGE)}
          className="-ml-1.5 flex min-h-8 items-center rounded-[5px] px-1.5 text-xs text-primary transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary [@media(pointer:coarse)]:min-h-11"
        >
          {t('Show {{count}} earlier entries', { count: hidden })}
        </button>
      )}
      {visible.map(entry => {
        switch (entry.kind) {
          case 'speech':
            return <div key={entry.id} className="py-1"><SpokenWords content={entry.thought.content} /></div>
          case 'arrivals':
            return <ReceivedRecords key={entry.id} thoughts={entry.thoughts} />
          case 'group':
            return <OperationGroup key={entry.id} steps={entry.steps} live={live} childGroups={childGroups} baseDir={baseDir} defaultOpen={showOperations} />
          case 'step':
            if (entry.thought.compaction) return <CompactionLine key={entry.id} thought={entry.thought} />
            if (entry.thought.type === 'system') return <NoticeLine key={entry.id} thought={entry.thought} />
            return <OperationRow key={entry.id} thought={entry.thought} live={live} childThoughts={childGroups.get(entry.id)} baseDir={baseDir} />
        }
      })}
    </div>
  )
}

const NO_IDS: ReadonlySet<string> = new Set()

export function WorkHistory({
  model,
  todos,
  live,
  activity,
  answer,
  liveTextIds,
  open,
  onToggle,
  showOperations = false,
  embedded = false,
  view = null,
  className = '',
}: WorkHistoryProps) {
  const { t } = useTranslation()
  const threadId = useId()
  const baseDir = useFileLinkOptions()?.baseDir
  const expanded = embedded || open
  // Outside a transcript that remembers, what is opened in this work is still kept while it is drawn.
  const ownView = useRef<WorkViewState>({ steps: new Map() })
  const shownView = view ?? ownView.current

  const steps = model.display
  const shownBelow = useMemo(() => liveTextIds ?? (answer ? answerTextIds(steps, answer) : NO_IDS), [liveTextIds, steps, answer])
  const hasWork = useMemo(() => hasWorkToShow(steps, shownBelow, live), [steps, shownBelow, live])
  // Built only while open: a folded reply needs none of it. Unchanged entries keep their identity.
  const streamRef = useRef<WorkStream | null>(null)
  const stream = useMemo(() => {
    if (!expanded) return null
    const next = nextWorkStream(streamRef.current, steps, shownBelow, live)
    streamRef.current = next
    return next
  }, [expanded, steps, shownBelow, live])
  const seconds = useMemo(() => (live ? undefined : workSeconds(model.thoughts)), [live, model.thoughts])

  const hasTodos = (todos?.length ?? 0) > 0
  const hasBody = hasWork || hasTodos
  if (!hasBody && !live && model.notices.length === 0) return null

  const tasks = hasTodos ? { done: todos!.filter(item => item.status === 'completed').length, total: todos!.length } : undefined
  // While running, the task in progress names what the reply is doing better than its latest tool.
  const currentTask = live ? todos?.find(item => item.status === 'in_progress') : undefined

  const thread = expanded && hasBody && stream && (
    <div id={threadId} className={embedded ? '' : 'mb-5 mt-1.5 border-b border-border-soft pb-3.5 animate-fade-in'}>
      {stream.entries.length > 0 && (
        <WorkViewScope view={shownView}>
          <Timeline entries={stream.entries} live={live} childGroups={model.childGroups} baseDir={baseDir} showOperations={showOperations} />
        </WorkViewScope>
      )}
      {hasTodos && (
        <div className={stream.entries.length > 0 ? 'mt-2.5' : ''}>
          <TodoCard todos={todos!} isAgentActive={live} />
        </div>
      )}
    </div>
  )

  if (embedded) return thread ? <div className={className}>{thread}</div> : null

  return (
    <div className={className}>
      {model.notices.map(notice => <SkillNotice key={notice.id} code={notice.skillNotice!} />)}
      {(hasBody || live) && (
        <WorkHistoryHeader
          label={live ? (currentTask ? currentTask.activeForm || currentTask.content : activity) ?? t('Working...') : t('Work process')}
          live={live}
          hasError={model.errorCount > 0}
          duration={formatWorkDuration(seconds, t)}
          // Progress stands in for the plan while the work is folded; open, the plan shows it.
          tasks={live && !open ? tasks : undefined}
          open={open}
          onToggle={hasBody ? onToggle : undefined}
          controls={threadId}
        />
      )}
      {thread}
    </div>
  )
}
