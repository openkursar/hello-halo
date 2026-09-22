/**
 * TeamCollabPanel — the collaboration of this conversation, inline in the
 * chat flow (same visual family as the old Agent-Team panel: header line +
 * one row per member with a status dot).
 *
 * Lives in the message list's footer, so it sits under the newest content
 * while members work in the background. Data is the live collaboration
 * projection, not thoughts — Halo members run outside this conversation's
 * turn. The header's only action opens the full Team view in the Content
 * Canvas; nothing opens automatically.
 *
 * The panel subscribes to that projection itself rather than receiving it from
 * the chat page: team events fire continuously while members work, and routing
 * them through the page would re-render the whole conversation view for each
 * one. It takes only a conversation id, so a parent re-render costs nothing.
 */

import { memo } from 'react'
import { Users, ArrowUpRight } from 'lucide-react'
import { canvasLifecycle } from '../../../services/canvas-lifecycle'
import { useTranslation } from '../../../i18n'
import { useCollabSummary } from './useCollabSummary'
import type { CollabMemberSummary } from '../../../../shared/apps/team-types'

function StatusDot({ status }: { status: CollabMemberSummary['status'] }) {
  const styles: Record<CollabMemberSummary['status'], string> = {
    working: 'bg-blue-500 animate-pulse',
    idle: 'bg-muted-foreground/50',
    waiting_user: 'bg-amber-500',
    error: 'bg-red-500',
  }
  return <div className={`w-2 h-2 rounded-full shrink-0 ${styles[status]}`} />
}

function statusText(member: CollabMemberSummary, t: (key: string) => string): string {
  switch (member.status) {
    case 'working':
      return member.currentTaskTitle || t('working')
    case 'waiting_user':
      return t('waiting for your decision')
    case 'error':
      return t('error')
    default:
      return member.currentTaskTitle || member.role
  }
}

export const TeamCollabPanel = memo(function TeamCollabPanel({ conversationId }: { conversationId?: string }) {
  const { t } = useTranslation()
  const collab = useCollabSummary(conversationId)
  if (!collab || collab.members.length === 0) return null

  const workingCount = collab.members.filter(m => m.status === 'working').length
  const headerState = collab.active
    ? t('{{count}}/{{total}} working', { count: workingCount, total: collab.members.length })
    : t('finished')

  return (
    <div className="mb-3 rounded-lg border border-border/50 bg-muted/30 p-3 animate-fade-in">
      <div className="flex items-center gap-2 mb-1.5 text-xs text-muted-foreground">
        <Users className="w-3.5 h-3.5 shrink-0" />
        <span className="font-medium truncate">{t('Team')}: {collab.name}</span>
        <span>·</span>
        <span className="shrink-0">{headerState}</span>
        <button
          onClick={() => void canvasLifecycle.openTeam(collab.teamId, collab.name)}
          className="ml-auto shrink-0 inline-flex items-center gap-0.5 text-primary hover:underline"
        >
          {t('Open team view')}
          <ArrowUpRight size={11} />
        </button>
      </div>

      <div className="space-y-0.5">
        {collab.members.map(member => (
          <div key={member.appId} className="flex items-center gap-2 py-1 text-sm min-w-0">
            <StatusDot status={member.status} />
            <span className="font-medium text-foreground shrink-0 max-w-[120px] truncate" title={member.memberName}>
              {member.memberName}
            </span>
            <span className="flex-1 text-muted-foreground truncate min-w-0 text-xs" title={member.role}>
              {statusText(member, t)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
})
