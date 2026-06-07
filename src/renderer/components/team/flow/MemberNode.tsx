/**
 * MemberNode — a React Flow custom node rendering a team workstation card.
 *
 * Read mode: status dot, ★ lead, working pulse, role / current-task summary;
 * clicking opens the member's chat.
 *
 * Edit mode: the card is draggable (rearrange freely) and, when selected, a
 * NodeToolbar floats beneath it with a "Connect to…" picker — click the node,
 * pick a teammate, done (the Dify-style "add the next link" gesture). Dragging
 * from the side dots is the power-user shortcut. No hidden gestures.
 */

import { memo, useContext, useState } from 'react'
import { Handle, Position, NodeToolbar } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'
import { Star, Loader2, AlertTriangle, Plus, ArrowRight } from 'lucide-react'
import type { RosterMember, TeamMemberRuntimeStatus } from '../../../../shared/apps/team-types'
import { FlowEditContext } from './flow-context'
import { useTranslation } from '../../../i18n'

export interface MemberNodeData {
  member: RosterMember
  editable: boolean
  /** Highlight while a message flow is active across this member. */
  active: boolean
  [key: string]: unknown
}

export type MemberFlowNode = Node<MemberNodeData, 'member'>

function statusDotClass(status: TeamMemberRuntimeStatus): string {
  switch (status) {
    case 'working': return 'bg-emerald-500'
    case 'error': return 'bg-red-500'
    case 'waiting_user': return 'bg-amber-500'
    default: return 'bg-muted-foreground/40'
  }
}

function MemberNodeImpl({ id, data, selected }: NodeProps<MemberFlowNode>) {
  const { t } = useTranslation()
  const { member, editable, active } = data
  const isLead = member.isLead
  const isWorking = member.status === 'working'
  const isAlert = member.status === 'error' || member.status === 'waiting_user'

  const summary =
    member.status === 'working'
      ? member.currentTaskTitle || ''
      : member.status === 'error'
        ? member.currentTaskTitle || ''
        : member.role || ''

  const handleStyle = editable
    ? '!h-3 !w-3 !border-2 !border-background !bg-primary shadow'
    : '!h-0 !w-0 !min-w-0 !min-h-0 !border-0 !bg-transparent'

  return (
    <div
      className={`group relative flex w-[200px] flex-col gap-1.5 rounded-xl border bg-background px-3 py-2.5 shadow-sm transition-colors
        ${selected ? 'border-primary ring-2 ring-primary/30'
          : active ? 'border-primary ring-1 ring-primary/40'
          : isAlert ? 'border-amber-500/50'
          : isWorking ? 'border-emerald-500/40'
          : isLead ? 'border-primary/40 shadow-md'
          : 'border-border'}`}
    >
      <Handle type="target" position={Position.Top} isConnectable={editable} className={handleStyle} />

      <div className="flex items-center gap-2">
        <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
          {isWorking && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />}
          <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${statusDotClass(member.status)}`} />
        </span>
        <span className="flex min-w-0 items-center gap-1 text-sm font-medium text-foreground">
          {isLead && <Star className="h-3.5 w-3.5 flex-shrink-0 fill-current text-amber-500" />}
          <span className="truncate">{member.memberName}</span>
        </span>
        {isAlert && <AlertTriangle className="ml-auto h-3.5 w-3.5 flex-shrink-0 text-amber-500" />}
        {isWorking && !isAlert && <Loader2 className="ml-auto h-3.5 w-3.5 flex-shrink-0 animate-spin text-emerald-500" />}
      </div>

      <span className="truncate text-xs text-muted-foreground">
        {summary || (isLead ? t('Team Lead') : '\u00A0')}
      </span>

      <Handle type="source" position={Position.Bottom} isConnectable={editable} className={handleStyle} />

      {editable && <ConnectToToolbar nodeId={id} visible={!!selected} />}
    </div>
  )
}

/** "Connect to…" picker shown beneath a selected node (Dify-style add link). */
function ConnectToToolbar({ nodeId, visible }: { nodeId: string; visible: boolean }) {
  const { t } = useTranslation()
  const edit = useContext(FlowEditContext)
  const [open, setOpen] = useState(false)

  if (!edit) return null

  // Members this node can still connect to (exclude self + existing targets).
  const targets = edit.roster.filter(
    m => m.appId !== nodeId && !edit.edges.some(e => e.fromAppId === nodeId && e.toAppId === m.appId),
  )

  return (
    <NodeToolbar isVisible={visible} position={Position.Bottom} offset={10}>
      <div className="nodrag nopan flex flex-col items-center">
        {!open ? (
          <button
            onClick={() => setOpen(true)}
            disabled={targets.length === 0}
            className="flex items-center gap-1 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-primary shadow-md transition-colors hover:bg-secondary disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('Connect to…')}
          </button>
        ) : (
          <div className="w-52 rounded-lg border border-border bg-popover p-1.5 shadow-lg">
            <p className="px-1.5 py-1 text-[11px] text-muted-foreground">{t('Let this member contact:')}</p>
            <div className="max-h-48 overflow-y-auto">
              {targets.length === 0 ? (
                <p className="px-1.5 py-2 text-xs text-muted-foreground/70">{t('Already connected to everyone.')}</p>
              ) : targets.map(m => (
                <button
                  key={m.appId}
                  onClick={() => { edit.addRelation(nodeId, m.appId, false); setOpen(false) }}
                  className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-secondary"
                >
                  <ArrowRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                  {m.isLead && <Star className="h-3 w-3 flex-shrink-0 fill-current text-amber-500" />}
                  <span className="truncate">{m.memberName}</span>
                </button>
              ))}
            </div>
            <button
              onClick={() => setOpen(false)}
              className="mt-1 w-full rounded-md px-1.5 py-1 text-center text-[11px] text-muted-foreground hover:bg-secondary"
            >
              {t('Cancel')}
            </button>
          </div>
        )}
      </div>
    </NodeToolbar>
  )
}

export const MemberNode = memo(MemberNodeImpl)
