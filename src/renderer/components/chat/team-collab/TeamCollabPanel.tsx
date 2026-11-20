/**
 * TeamCollabPanel — the collaboration of this conversation as one line at the
 * end of the chat: the team's name, how many members it has and how many are
 * working. Members can keep working after a reply ends, so it belongs to the
 * conversation, not to any reply. The full team, member by member, is one
 * click away in the Team view (Content Canvas); nothing opens automatically.
 *
 * Data is the live collaboration projection, not thoughts — Halo members run
 * outside this conversation's turn. The panel subscribes to that projection
 * itself rather than receiving it from the chat page: team events fire
 * continuously while members work, and routing them through the page would
 * re-render the whole conversation view for each one. It takes only a
 * conversation id, so a parent re-render costs nothing.
 */

import { memo } from 'react'
import { Users, ArrowUpRight } from 'lucide-react'
import { canvasLifecycle } from '../../../services/canvas-lifecycle'
import { useTranslation } from '../../../i18n'
import { useCollabSummary } from '../../../hooks/useCollabSummary'

export const TeamCollabPanel = memo(function TeamCollabPanel({ conversationId }: { conversationId?: string }) {
  const { t } = useTranslation()
  const collab = useCollabSummary(conversationId)
  if (!collab || collab.members.length === 0) return null

  const total = collab.members.length
  const working = collab.members.filter(member => member.status === 'working').length
  // Only a sealed collaboration is finished; nobody working right now is not the same thing.
  const state = collab.active
    ? t('{{count}} members, {{working}} working', { count: total, working })
    : t('{{count}} members, finished', { count: total })

  return (
    <div
      role="group"
      aria-label={collab.name}
      className="mb-3 flex min-h-9 min-w-0 items-center gap-2 rounded-lg bg-secondary/40 px-3 py-1 text-xs text-muted-foreground animate-fade-in"
    >
      <Users size={14} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 max-w-[45%] shrink truncate font-medium text-foreground" title={collab.name}>{collab.name}</span>
      <span aria-hidden="true" className="shrink-0">·</span>
      <span className="min-w-0 flex-1 truncate tabular-nums">{state}</span>
      <button
        type="button"
        onClick={() => void canvasLifecycle.openTeam(collab.teamId, collab.name)}
        className="-mr-1.5 inline-flex min-h-8 shrink-0 items-center gap-0.5 rounded-[5px] px-1.5 text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary [@media(pointer:coarse)]:min-h-11"
      >
        {t('View team')}
        <ArrowUpRight size={12} aria-hidden="true" />
      </button>
    </div>
  )
})
