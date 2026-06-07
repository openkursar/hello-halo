/**
 * FlowEditContext — the single set of edit operations shared by every surface
 * of the structure editor (canvas drag-connect, node "connect to…" toolbar, and
 * the floating relationships panel). Provided by TeamFlowCanvas; consumed by the
 * member node and the panel so no callbacks need threading through React Flow.
 *
 * All edits are expressed in domain terms (from/to appId + sync), never in
 * React-Flow edge ids, so the owner can persist them straight to team_edges.
 */

import { createContext } from 'react'
import type { RosterMember, TeamEdge } from '../../../../shared/apps/team-types'

export interface FlowEdit {
  editable: boolean
  roster: RosterMember[]
  edges: TeamEdge[]
  addRelation: (fromAppId: string, toAppId: string, sync: boolean) => void
  removeRelation: (fromAppId: string, toAppId: string) => void
  setSync: (fromAppId: string, toAppId: string, sync: boolean) => void
}

export const FlowEditContext = createContext<FlowEdit | null>(null)
