/**
 * How a goal's state reads everywhere it appears: always an icon plus a word,
 * never color alone.
 */

import { Target, CheckCircle2, CircleSlash } from 'lucide-react'
import type { Goal } from '../../stores/goal.store'

type Translate = (key: string, options?: Record<string, unknown>) => string

export function goalStatusLabel(goal: Goal, running: boolean, t: Translate): string {
  switch (goal.status) {
    case 'complete': return t('Goal achieved')
    case 'abandoned': return t('Goal abandoned')
    default: return running ? t('Pursuing goal') : t('Goal')
  }
}

interface GoalStatusIconProps {
  goal: Goal
  running: boolean
  /** The user's latest change has not reached the model yet. */
  pending?: boolean
  size?: number
}

export function GoalStatusIcon({ goal, running, pending = false, size = 14 }: GoalStatusIconProps) {
  if (goal.status === 'complete') {
    // Keyed by status so reaching it replays the entrance.
    return <CheckCircle2 key="complete" size={size} aria-hidden className="shrink-0 text-halo-success animate-pop-in" />
  }
  if (goal.status === 'abandoned') {
    return <CircleSlash key="abandoned" size={size} aria-hidden className="shrink-0 text-muted-foreground" />
  }
  return (
    <span key="active" className="relative shrink-0 inline-flex" aria-hidden>
      <Target size={size} className={`text-primary ${running ? 'animate-pulse-gentle' : ''}`} />
      {pending && (
        <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-primary ring-2 ring-background" />
      )}
    </span>
  )
}
