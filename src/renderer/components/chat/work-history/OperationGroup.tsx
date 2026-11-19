/**
 * A stretch of operations between two things the AI said, as one line:
 * "Ran 5 commands, searched 3 times and read 1 file". Opened, it lists every
 * step; a long stretch opens near the latest steps in a bounded scroll area
 * and loads earlier ones on request. A
 * stretch with at most one operation is drawn as its own lines instead.
 *
 * The line stays neutral whatever its steps returned: an error a tool reported
 * is part of the work, shown only on that step's own line. The header above is
 * the one place that spins while the reply runs; here the step in progress is
 * named in the primary color.
 */

import { memo, useId, useLayoutEffect, useRef, useState } from 'react'
import { describeThoughtActivity } from '../../../utils/thought-activity'
import { PROCESS_CUE, PROCESS_LINE } from '../process-line'
import { OperationRow } from './OperationRow'
import { operationIcon } from './operation-label'
import { summarizeGroup } from './group-summary'
import { useRememberedOpen, useWorkViewScope } from './view-memory'
import type { Thought } from '../../../types'
import { getCurrentLanguage, useTranslation } from '../../../i18n'

/** Steps a stretch lists when opened; more come in pages of the same size. */
export const GROUP_PAGE = 50
/** Kinds a summary names before it says "and other work". */
const SUMMARY_KINDS = 3
const INLINE_STEPS = 10

type Translate = (key: string, options?: Record<string, unknown>) => string

function lowerFirst(text: string): string {
  return text.charAt(0).toLocaleLowerCase() + text.slice(1)
}

/** "Ran 5 commands, searched 3 times and read 1 file" in the language in use. */
function summaryText(parts: Array<{ key: string; count: number }>, t: Translate): string {
  const named = parts.slice(0, SUMMARY_KINDS).map((part, i) => {
    const text = t(part.key, { count: part.count })
    return i === 0 ? text : lowerFirst(text)
  })
  if (parts.length > SUMMARY_KINDS) named.push(t('other work'))
  return new Intl.ListFormat(getCurrentLanguage(), { style: 'long', type: 'conjunction' }).format(named)
}

interface OperationGroupProps {
  steps: readonly Thought[]
  live: boolean
  childGroups: ReadonlyMap<string, Thought[]>
  baseDir?: string
  /** Start open, as trace views want every step in view. */
  defaultOpen?: boolean
}

function sameGroup(a: OperationGroupProps, b: OperationGroupProps): boolean {
  if (a.live !== b.live || a.baseDir !== b.baseDir || a.defaultOpen !== b.defaultOpen) return false
  if (a.steps !== b.steps && (a.steps.length !== b.steps.length || a.steps.some((step, i) => step !== b.steps[i]))) return false
  return a.childGroups === b.childGroups || a.steps.every(step => a.childGroups.get(step.id) === b.childGroups.get(step.id))
}

export const OperationGroup = memo(function OperationGroup({ steps, live, childGroups, baseDir, defaultOpen = false }: OperationGroupProps) {
  const { t } = useTranslation()
  const key = `group:${steps[0]?.id}`
  const view = useWorkViewScope()
  const [chosen, setOpen] = useRememberedOpen(key, defaultOpen)
  // A step the person opened is not folded away when the next step joins it into a stretch.
  const open = chosen || (view?.steps.get(key) === undefined && steps.some(step => view?.steps.get(step.id) === true))
  const panelId = useId()
  const headingId = `${panelId}-heading`
  const [earlier, setEarlier] = useState(0)

  const summary = summarizeGroup(steps, live)
  // At most one operation: its own line opens its result in one click, beside any reasoning before it.
  if (summary.counted <= 1) {
    return <>
      {steps.map(step => (
        <OperationRow key={step.id} thought={step} live={live} childThoughts={childGroups.get(step.id)} baseDir={baseDir} />
      ))}
    </>
  }

  const activity = summary.running ? describeThoughtActivity([summary.running]) : undefined
  const Icon = operationIcon(summary.lead!)
  const subject = summaryText(summary.parts, t)
  const activityText = activity ? t(activity.key, activity.params) : ''
  return (
    <div className="min-w-0">
      <button
        type="button"
        id={headingId}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={[subject, activityText].filter(Boolean).join(' · ')}
        className={PROCESS_LINE}
      >
        <Icon size={14} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 truncate text-[13px] text-muted-foreground">{subject}</span>
        {activityText && <span className="min-w-0 shrink-[2] truncate text-[11px] text-primary">{activityText}</span>}
        <span aria-hidden="true" className={PROCESS_CUE}>{open ? t('Collapse') : t('Expand')}</span>
      </button>
      {open && (
        <GroupSteps steps={steps} live={live} childGroups={childGroups} baseDir={baseDir}
          panelId={panelId} headingId={headingId} earlier={earlier} onEarlier={setEarlier} />
      )}
    </div>
  )
}, sameGroup)

const PAGE_ACTION = '-mx-1.5 flex min-h-8 items-center rounded-[5px] px-1.5 text-xs text-primary transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary [@media(pointer:coarse)]:min-h-11'

function GroupSteps({ steps, live, childGroups, baseDir, panelId, headingId, earlier, onEarlier }: Omit<OperationGroupProps, 'defaultOpen'> & {
  panelId: string
  headingId: string
  earlier: number
  onEarlier: (count: number) => void
}) {
  const { t } = useTranslation()
  const list = useRef<HTMLDivElement>(null)
  // Once a page fills, new steps must not evict the ones the person is reading.
  const [pageEnd, setPageEnd] = useState(() => Math.max(GROUP_PAGE, steps.length))
  const end = Math.min(pageEnd, steps.length)
  const start = Math.max(0, end - GROUP_PAGE - earlier)
  const scrollable = end - start > INLINE_STEPS
  const position = useRef<number | 'end' | null>('end')

  useLayoutEffect(() => {
    const el = list.current
    if (!el || position.current === null) return
    el.scrollTop = position.current === 'end' ? el.scrollHeight : el.scrollHeight - position.current
    position.current = null
  }, [start, end])

  return (
    <div
      id={panelId}
      ref={list}
      role={scrollable ? 'group' : undefined}
      aria-labelledby={scrollable ? headingId : undefined}
      tabIndex={scrollable ? 0 : undefined}
      className={`mb-1.5 ml-[7px] mt-px border-l border-border-soft pl-2.5 ${scrollable
        ? 'max-h-[min(50dvh,20rem)] overflow-y-auto px-2.5 py-0.5 scrollbar-thin focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary' : ''}`}
    >
      {start > 0 && (
        <button
          type="button"
          onClick={() => {
            const el = list.current
            if (el) {
              position.current = el.scrollHeight - el.scrollTop
              if (start <= GROUP_PAGE) el.focus({ preventScroll: true })
            }
            onEarlier(earlier + GROUP_PAGE)
          }}
          className={PAGE_ACTION}
        >
          {t('Show {{count}} earlier steps', { count: start })}
        </button>
      )}
      {steps.slice(start, end).map(step => (
        <OperationRow key={step.id} thought={step} live={live} childThoughts={childGroups.get(step.id)} baseDir={baseDir} />
      ))}
      {end < steps.length && (
        <button type="button" onClick={() => {
          position.current = 'end'
          onEarlier(0)
          setPageEnd(steps.length)
          list.current?.focus({ preventScroll: true })
        }} className={PAGE_ACTION}>
          {t('Back to latest')}
        </button>
      )}
    </div>
  )
}
