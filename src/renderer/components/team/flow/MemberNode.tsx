/**
 * MemberNode — the React Flow custom node for a team member.
 *
 * A thin wrapper that owns the wiring concerns (source/target handles, and the
 * edit-mode "Connect to…" toolbar) and delegates the card's look to a skin:
 *  - default: plain status card (DefaultMemberCard)
 *  - cartoon: office workstation (WorkstationCard)
 *
 * The skin is a client-local, per-office preference. Edit mode always uses the
 * default card — wiring edges between desks is worse than between plain cards.
 */

import { memo, useContext, useState } from 'react'
import { Handle, Position, NodeToolbar } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'
import { Star, Plus, ArrowRight } from 'lucide-react'
import type { RosterMember } from '../../../../shared/apps/team-types'
import { FlowEditContext } from './flow-context'
import { useTranslation } from '../../../i18n'
import { useOfficeSkin } from '../../../stores/team-view-prefs.store'
import { useMemberView } from './member-view'
import { DefaultMemberCard } from './skins/DefaultMemberCard'
import { WorkstationCard } from './skins/WorkstationCard'

export interface MemberNodeData {
  member: RosterMember
  editable: boolean
  /** Office this node belongs to — resolves the member's owner + presence. */
  teamId: string
  /** Highlight while a message flow is active across this member. */
  active: boolean
  /** The event the floor is focused on, so the node can flag "busy elsewhere". */
  focusedEpochId?: string | null
  [key: string]: unknown
}

export type MemberFlowNode = Node<MemberNodeData, 'member'>

function MemberNodeImpl({ id, data, selected }: NodeProps<MemberFlowNode>) {
  const { member, editable, active, teamId, focusedEpochId } = data
  const view = useMemberView(member, teamId, focusedEpochId)
  const skin = useOfficeSkin(teamId)
  const cartoon = skin === 'cartoon' && !editable

  const handleStyle = editable
    ? '!h-3 !w-3 !border-2 !border-background !bg-primary shadow'
    : '!h-0 !w-0 !min-w-0 !min-h-0 !border-0 !bg-transparent'

  return (
    <div className="relative w-[200px]">
      <Handle type="target" position={Position.Top} isConnectable={editable} className={handleStyle} />

      {cartoon
        ? <WorkstationCard view={view} active={active} />
        : <DefaultMemberCard view={view} selected={!!selected} active={active} />}

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
