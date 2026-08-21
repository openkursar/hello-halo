/**
 * EscalationPanel — the decisions one teammate is waiting on.
 *
 * A team escalation is the SAME object as the member app's escalation — there
 * is no separate team-side escalation store. This panel frames the member
 * context and delegates the question / choices / response UI to the shared
 * EscalationCard, which resolves the one underlying escalation object (so
 * responding once updates both the member panel and the team view).
 *
 * A member can owe more than one decision at a time: it asks, ends its turn, is
 * woken again by a teammate or a periodic check, and hits a second wall. Hence a
 * queue, worked oldest-first, with the remaining count on screen.
 *
 * Only ever mounted for a member of the reader's OWN: the escalation lives in
 * that member's activity feed, which exists on its owner's machine alone.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import type { RosterMember } from '../../../shared/apps/team-types'
import { useAppsStore } from '../../stores/apps.store'
import { EscalationCard } from '../apps/EscalationCard'
import { useTranslation } from '../../i18n'
import { formatTimeAgo } from '../../utils/time'

interface EscalationPanelProps {
  member: RosterMember
}

/** What the reader just decided, kept on screen after the queue drops it. */
interface DecisionReceipt {
  question: string
  answer: string
}

export function EscalationPanel({ member }: EscalationPanelProps) {
  const { t } = useTranslation()
  const entries = useAppsStore(s => s.activityEntries[member.appId])
  const loadActivity = useAppsStore(s => s.loadActivity)
  const [loading, setLoading] = useState(true)

  // The escalation object lives in the member app's activity feed. Load it so
  // we can render the same unresolved entry the member detail page would.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void loadActivity(member.appId).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [member.appId, loadActivity])

  // Oldest first: under newest-first, answering the top one promotes an older
  // question into the same slot, which reads as "my answer did nothing".
  const queue = useMemo(
    () => (entries ?? [])
      .filter(e => e.type === 'escalation' && !e.userResponse)
      .sort((a, b) => a.ts - b.ts),
    [entries]
  )
  const current = queue[0]
  const currentId = current?.id ?? null

  const [receipt, setReceipt] = useState<DecisionReceipt | null>(null)
  const shownIdRef = useRef<string | null>(null)
  useEffect(() => {
    const shownId = shownIdRef.current
    shownIdRef.current = currentId
    if (!shownId || shownId === currentId) return
    // The question on screen left the queue. Only an answered one has a response
    // to show; withdrawn or superseded ones leave without a receipt.
    const answered = entries?.find(e => e.id === shownId)
    const response = answered?.userResponse
    if (!answered || !response) return
    // A timeout or an orphaned escalation is recorded as a response too, and
    // showing it back would tell the reader they answered something they never
    // saw. Matching the marker text is brittle: the backend rewording it breaks
    // this silently, and it breaks towards showing the false receipt again.
    // (src/main/apps/runtime/service.ts, store.ts)
    if ((response.text ?? '').startsWith('[Auto-closed]')) return
    setReceipt({
      question: answered.content.question ?? answered.content.summary,
      answer: response.choice ?? response.text ?? '',
    })
  }, [currentId, entries])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
        <p className="min-w-0 flex-1 text-sm text-foreground">
          {t('{{member}} needs your decision:', { member: member.memberName })}
        </p>
        {queue.length > 1 && (
          <span className="flex-shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-600 dark:text-amber-500">
            {t('{{count}} waiting', { count: queue.length })}
          </span>
        )}
      </div>

      {receipt && (
        <div className="flex items-start gap-2 rounded-md bg-secondary/50 px-2.5 py-2 text-xs text-muted-foreground">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-green-500" />
          {/* A question can run to paragraphs; this is a receipt for something
              already decided, not the decision itself. */}
          <p className="line-clamp-2 min-w-0" title={receipt.question}>
            {t('Sent your answer to "{{question}}": {{answer}}', {
              question: receipt.question,
              answer: receipt.answer,
            })}
          </p>
        </div>
      )}

      {current ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] text-muted-foreground">
            {t('Asked {{when}}', { when: formatTimeAgo(current.ts, t) })}
          </p>
          {/* Keyed so the next question arrives with an empty box, not the text
              typed for the previous one. */}
          <EscalationCard key={current.id} entry={current} appId={member.appId} />
        </div>
      ) : (
        // Still arriving, the queue just emptied, or it arrived holding nothing
        // open — three different facts, never the same sentence.
        <p className="text-sm text-muted-foreground">
          {loading
            ? t('Loading the pending decision…')
            : receipt
              // Only this member's queue is in scope here — the panel is given
              // one member and reads one feed. Whether anything is waiting
              // elsewhere is the attention banner's to say.
              ? t('That was the last one from {{name}}.', { name: member.memberName })
              : t('This decision is no longer pending.')}
        </p>
      )}
    </div>
  )
}
