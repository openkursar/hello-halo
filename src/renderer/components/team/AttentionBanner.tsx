/**
 * AttentionBanner — the always-present "someone needs your decision" bar
 * (spec §6.7 / C2). It rides above the tab bar on EVERY tab, so a waiting
 * decision follows the user wherever they are and never depends on which tab is
 * open. Multiple waits collapse into one expandable bar. Clicking a decision
 * opens that member's chat, where the shared EscalationCard resolves it.
 *
 * This is the middle link of the attention chain (system notification → list
 * badge → THIS banner → member card pulse → history record); it does not own the
 * escalation, it only routes the user to it.
 */

import { useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react'
import type { TeamPendingEscalation } from '../../../shared/apps/team-types'
import { useTranslation } from '../../i18n'

interface AttentionBannerProps {
  pending: TeamPendingEscalation[]
  /** Open the member's chat (where the decision panel is shown inline). */
  onGoTo: (appId: string) => void
}

export function AttentionBanner({ pending, onGoTo }: AttentionBannerProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  if (pending.length === 0) return null

  // Single wait: a one-line, directly-actionable bar.
  if (pending.length === 1) {
    const e = pending[0]
    return (
      <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 sm:px-4">
        <AlertTriangle className="h-4 w-4 flex-shrink-0 text-amber-500" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          {t('{{member}} is waiting for your decision: {{question}}', {
            member: e.memberName,
            question: e.question || t('a decision'),
          })}
        </span>
        <button
          onClick={() => onGoTo(e.appId)}
          className="flex-shrink-0 rounded-md border border-amber-500/40 bg-background px-2.5 py-1 text-xs font-medium text-amber-600 transition-colors hover:bg-amber-500/10 dark:text-amber-400"
        >
          {t('Handle it')}
        </button>
      </div>
    )
  }

  // Many waits: a collapsible summary.
  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10">
      <button
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left sm:px-4"
      >
        <AlertTriangle className="h-4 w-4 flex-shrink-0 text-amber-500" />
        <span className="flex-1 text-sm font-medium text-foreground">
          {t('{{count}} decisions are waiting for you', { count: pending.length })}
        </span>
        {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
      </button>
      {expanded && (
        <ul className="border-t border-amber-500/20 px-3 pb-2 sm:px-4">
          {pending.map(e => (
            <li key={e.entryId} className="flex items-center gap-2 py-1.5">
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                <span className="font-medium">{e.memberName}</span>
                <span className="text-muted-foreground"> · {e.question || t('a decision')}</span>
              </span>
              <button
                onClick={() => onGoTo(e.appId)}
                className="flex-shrink-0 rounded-md border border-amber-500/40 bg-background px-2 py-0.5 text-xs text-amber-600 transition-colors hover:bg-amber-500/10 dark:text-amber-400"
              >
                {t('Handle it')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
