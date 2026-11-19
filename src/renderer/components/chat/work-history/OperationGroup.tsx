/**
 * A stretch of operations between two things the AI said, as one line:
 * "Ran 5 commands, searched 3 times and read 1 file". Opened, it lists every
 * step; a long stretch lists the latest ones first and loads earlier ones on
 * request, so a run of hundreds of steps costs one line until asked for. A
 * stretch with at most one operation is drawn as its own lines instead.
 *
 * The line stays neutral whatever its steps returned: an error a tool reported
 * is part of the work, shown only on that step's own line. The header above is
 * the one place that spins while the reply runs; here the step in progress is
 * named in the primary color.
 */

import { memo, useState } from 'react'
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
  const [shown, setShown] = useState(GROUP_PAGE)

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
  const hidden = Math.max(0, steps.length - shown)
  const visible = hidden > 0 ? steps.slice(hidden) : steps

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={[subject, activityText].filter(Boolean).join(' · ')}
        className={PROCESS_LINE}
      >
        <Icon size={14} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 truncate text-[13px] text-muted-foreground">{subject}</span>
        {activityText && <span className="min-w-0 shrink-[2] truncate text-[11px] text-primary">{activityText}</span>}
        <span aria-hidden="true" className={PROCESS_CUE}>{open ? t('Collapse') : t('Expand')}</span>
      </button>
      {open && (
        <div className="mb-1.5 ml-[7px] mt-px border-l border-border-soft pl-2.5">
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setShown(shown + GROUP_PAGE)}
              className="-mx-1.5 flex min-h-8 items-center rounded-[5px] px-1.5 text-xs text-primary transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary [@media(pointer:coarse)]:min-h-11"
            >
              {t('Show {{count}} earlier steps', { count: hidden })}
            </button>
          )}
          {visible.map(step => (
            <OperationRow key={step.id} thought={step} live={live} childThoughts={childGroups.get(step.id)} baseDir={baseDir} />
          ))}
        </div>
      )}
    </div>
  )
}, sameGroup)
