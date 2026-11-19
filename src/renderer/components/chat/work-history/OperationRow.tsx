/**
 * One operation in a single line. A click on the line opens what Halo already
 * shows for that step — the tool's result viewer, its raw input, a sub-agent's
 * steps, an error — directly beneath it. The line itself never changes shape:
 * its subject is cut to a fixed length (or shorter, by a narrow window), and
 * a command or path cut short is shown whole as the first line of what opens.
 *
 * A tool the harness answered with an error is normal work the AI reads and
 * moves on from, not a failure of the reply: only its icon is tinted, and no
 * line says it did not succeed.
 */

import { memo, useLayoutEffect, useRef, useState } from 'react'
import { Braces } from 'lucide-react'
import { ToolResultViewer } from '../tool-result'
import { NestedToolTimeline } from '../NestedToolTimeline'
import { ErrorContent } from '../ErrorContent'
import { NO_CHILD_THOUGHTS } from '../thought-utils'
import { clipSubject, PROCESS_CUE, PROCESS_DETAIL, PROCESS_LINE } from '../process-line'
import { describeOperation, editStats, operationIcon } from './operation-label'
import { operationStatus } from './operation-status'
import { useRememberedOpen } from './view-memory'
import type { Thought } from '../../../types'
import { getCurrentLanguage, useTranslation } from '../../../i18n'

interface OperationRowProps {
  thought: Thought
  live: boolean
  /** Steps a sub-agent took under this one. */
  childThoughts?: Thought[]
  /** Paths inside it are shown relative to it. */
  baseDir?: string
}

export const OperationRow = memo(function OperationRow({ thought, live, childThoughts, baseDir }: OperationRowProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useRememberedOpen(thought.id, false)
  // A narrow window can cut a subject shorter than its fixed length; what opens then shows it whole.
  const subjectRef = useRef<HTMLSpanElement>(null)
  const [cutByWidth, setCutByWidth] = useState(false)
  useLayoutEffect(() => {
    const el = subjectRef.current
    if (open && el) setCutByWidth(el.scrollWidth > el.clientWidth + 1)
  }, [open])
  const status = operationStatus(thought, live)
  const label = describeOperation(thought, baseDir)
  const subject = clipSubject(label.target)
  const active = status === 'running' || status === 'generating'
  const Icon = operationIcon(thought)
  const iconColor = thought.type === 'error' ? 'text-destructive'
    : active ? 'text-primary'
    : status === 'failed' ? 'text-halo-warning/75'
    : ''
  const kind = label.translate ? t(label.kind) : label.kind
  const stats = editStats(thought)
  const tools = thought.taskProgress?.toolCount
  const isTool = thought.type === 'tool_use'

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={[kind, isTool ? label.target : subject.text, active ? t('Running') : ''].filter(Boolean).join(' · ')}
        className={PROCESS_LINE}
      >
        <Icon size={14} aria-hidden="true" className={`shrink-0 ${iconColor}`} />
        <span className={`shrink-0 whitespace-nowrap ${active ? 'text-primary' : ''}`}>{kind}</span>
        {subject.text && (
          <span ref={subjectRef} className={`min-w-0 truncate text-muted-foreground ${label.monospace ? 'font-mono' : 'text-[13px]'}`}>
            {subject.text}
          </span>
        )}
        {stats && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums">
            <span className="text-halo-success">+{stats.added}</span>
            {stats.removed > 0 && <span className="text-destructive"> −{stats.removed}</span>}
          </span>
        )}
        {!!tools && <span className="shrink-0 text-[11px] tabular-nums">{t('{{count}} tools used', { count: tools })}</span>}
        <span aria-hidden="true" className={PROCESS_CUE}>{open ? t('Collapse') : t('View')}</span>
      </button>
      {open && (
        <OperationDetail
          thought={thought}
          live={live}
          childThoughts={childThoughts}
          fullTarget={isTool && (subject.clipped || cutByWidth) ? label.target : undefined}
        />
      )}
    </div>
  )
})

function OperationDetail({ thought, live, childThoughts, fullTarget }: { thought: Thought; live: boolean; childThoughts?: Thought[]; fullTarget?: string }) {
  const { t } = useTranslation()
  const [showInput, setShowInput] = useState(false)
  const hasInput = thought.type === 'tool_use' && !!thought.toolInput && Object.keys(thought.toolInput).length > 0
  const time = new Date(thought.timestamp)
  const when = [
    Number.isNaN(time.getTime()) ? '' : time.toLocaleTimeString(getCurrentLanguage(), { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    thought.duration ? `${(thought.duration / 1000).toFixed(1)}s` : '',
  ].filter(Boolean).join(' · ')

  return (
    <div className={`${PROCESS_DETAIL} thought-content`}>
      {fullTarget && (
        <pre className="mb-1 whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{fullTarget}</pre>
      )}
      <OperationBody thought={thought} live={live} childThoughts={childThoughts} />
      {(when || hasInput) && (
        <div className="mt-1 flex min-h-6 items-center gap-1.5 text-[11px] tabular-nums text-faint-foreground">
          {when && <span>{when}</span>}
          {hasInput && (
            <button
              type="button"
              onClick={() => setShowInput(!showInput)}
              aria-pressed={showInput}
              title={showInput ? t('Hide raw JSON') : t('Show raw JSON')}
              aria-label={showInput ? t('Hide raw JSON') : t('Show raw JSON')}
              className={`flex h-6 shrink-0 items-center rounded px-1.5 transition-colors [@media(pointer:coarse)]:h-9 ${
                showInput ? 'bg-primary/15 text-primary' : 'hover:bg-secondary/60 hover:text-muted-foreground'
              }`}
            >
              <Braces size={12} />
            </button>
          )}
        </div>
      )}
      {showInput && (
        <pre className="mt-1 overflow-x-auto rounded bg-muted/30 p-2 text-xs text-muted-foreground">
          {JSON.stringify(thought.toolInput, null, 2)}
        </pre>
      )}
    </div>
  )
}

function OperationBody({ thought, live, childThoughts }: { thought: Thought; live: boolean; childThoughts?: Thought[] }) {
  const { t } = useTranslation()
  switch (thought.type) {
    case 'tool_use':
      return <>
        {thought.toolResult ? (
          <ToolResultViewer
            toolName={thought.toolName || ''}
            toolInput={thought.toolInput}
            output={thought.toolResult.output}
            isError={thought.toolResult.isError}
          />
        ) : (
          <p className="mt-1 text-xs text-faint-foreground">{live ? t('No result yet') : t('No result')}</p>
        )}
        {(childThoughts || thought.taskProgress) && (
          <NestedToolTimeline
            thoughts={childThoughts ?? NO_CHILD_THOUGHTS}
            parentToolUseId={thought.id}
            taskProgress={thought.taskProgress}
            isThinking={live}
          />
        )}
      </>
    case 'tool_result':
      return <ToolResultViewer toolName="" output={thought.toolOutput || thought.content} isError={thought.isError} />
    case 'error':
      return <ErrorContent content={thought.content} />
    case 'thinking':
      return <p className="mt-1 whitespace-pre-wrap break-words text-[13px] italic text-muted-foreground">{thought.content || '…'}</p>
    default:
      return <p className="mt-1 whitespace-pre-wrap break-words text-xs text-faint-foreground">{thought.content}</p>
  }
}
