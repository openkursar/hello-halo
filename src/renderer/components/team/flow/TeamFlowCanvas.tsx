/**
 * TeamFlowCanvas — the team topology canvas (React Flow + dagre).
 *
 * One engine, two modes:
 *  - read mode (status board): live status nodes, animated edges while a message
 *    flows, click a node to open that member; not draggable / not editable.
 *  - edit mode (collaboration structure): nodes are draggable to rearrange; three
 *    visible ways to wire links, all funnelling to the same domain operations —
 *    (1) drag from a member's side dot to another, (2) click a member → its
 *    "Connect to…" toolbar, (3) the floating Relationships panel (add/remove/
 *    sync). No hidden gestures.
 *
 * dagre seeds a clean, crossing-minimized layout; React Flow renders + handles
 * interaction. Theme follows Halo's light/dark class via colorMode.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
  ConnectionLineType,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type ColorMode,
  type NodeMouseHandler,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { RosterMember, TeamEdge } from '../../../../shared/apps/team-types'
import type { ActiveFlow } from '../../../stores/team.store'
import { MemberNode, type MemberFlowNode } from './MemberNode'
import { RelationEdge } from './RelationEdge'
import { RelationshipsPanel } from './RelationshipsPanel'
import { FlowEditContext, type FlowEdit } from './flow-context'
import { layoutNodes, NODE_H, NODE_H_CARTOON } from './layout'
import { useOfficeSkin } from '../../../stores/team-view-prefs.store'

const nodeTypes = { member: MemberNode }
const edgeTypes = { relation: RelationEdge }

interface TeamFlowCanvasProps {
  roster: RosterMember[]
  edges: TeamEdge[]
  teamId: string
  /** read: status board; edit: collaboration structure editor. */
  editable?: boolean
  /** Live message flows (read mode) → animate the matching edge. */
  activeFlows?: ActiveFlow[]
  /** Open a member (read mode node click). */
  onSelectMember?: (member: RosterMember) => void
  /** The event the floor is focused on, so a node can flag "busy elsewhere" (§6.3). */
  focusedEpochId?: string | null
  /** Domain edit operations (edit mode). The owner persists them. */
  onAddRelation?: (fromAppId: string, toAppId: string, sync: boolean) => void
  onRemoveRelation?: (fromAppId: string, toAppId: string) => void
  onSetSync?: (fromAppId: string, toAppId: string, sync: boolean) => void
}

/** Detect Halo's current color scheme from the documentElement class. */
function useColorMode(): ColorMode {
  const get = (): ColorMode => {
    if (typeof document === 'undefined') return 'dark'
    // Halo's theme SSOT is the <html> class: `.light` = light theme, otherwise
    // the default `:root` dark theme (there is no `.dark` class). We must NOT
    // fall back to the OS preference — React Flow stamps this mode as a class on
    // the canvas, and a mismatched `light` class would re-scope the light theme
    // variables over the nodes, flipping cards to light inside a dark app.
    return document.documentElement.classList.contains('light') ? 'light' : 'dark'
  }
  const [mode, setMode] = useState<ColorMode>(get)
  useEffect(() => {
    const obs = new MutationObserver(() => setMode(get()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])
  return mode
}

// ── Edge styling ────────────────────────────────────────────────────────────

function styleEdge(id: string, source: string, target: string, sync: boolean, active: boolean): Edge {
  const color = active ? 'hsl(var(--primary))' : sync ? 'hsl(var(--primary) / 0.65)' : 'hsl(var(--muted-foreground) / 0.6)'
  return {
    id, source, target,
    type: 'relation',
    animated: active,
    data: { sync, active },
    markerEnd: { type: MarkerType.ArrowClosed, color, width: 18, height: 18 },
  }
}

function buildEdges(roster: RosterMember[], teamEdges: TeamEdge[], activeFlows: ActiveFlow[]): Edge[] {
  const isActive = (from: string, to: string) =>
    activeFlows.some(f => (f.fromAppId === from && f.toAppId === to) || (f.fromAppId === to && f.toAppId === from))
  return teamEdges
    .filter(e => roster.some(m => m.appId === e.fromAppId) && roster.some(m => m.appId === e.toAppId))
    .map(e => styleEdge(`${e.fromAppId}__${e.toAppId}`, e.fromAppId, e.toAppId, e.sync, isActive(e.fromAppId, e.toAppId)))
}

/** A single potted plant fixed in the canvas corner — a calm office accent for
 *  the cartoon skin. Frame-fixed (not part of the pannable scene) by design. */
function OfficePlant() {
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-0 opacity-90">
      <svg width={60} height={78} viewBox="0 0 64 84" fill="none" role="presentation">
        <ellipse cx={32} cy={80} rx={22} ry={4} fill="hsl(var(--secondary) / 0.5)" />
        <path d="M32 52 C10 40 8 14 20 4 C22 20 30 18 32 30 C34 18 42 12 46 4 C56 16 52 42 32 52 Z" fill="hsl(152 40% 42%)" />
        <path d="M32 52 C25 45 21 31 25 21 C28 31 30 35 32 45 Z" fill="hsl(152 44% 33%)" />
        <rect x={14} y={49} width={36} height={7} rx={2} fill="hsl(var(--muted))" stroke="hsl(var(--border))" strokeWidth={1.5} />
        <path d="M17 56 h30 l-4 22 h-22 Z" fill="hsl(var(--secondary))" stroke="hsl(var(--border))" strokeWidth={1.5} />
      </svg>
    </div>
  )
}

function InnerCanvas({
  roster, edges: teamEdges, teamId, editable = false, activeFlows = [],
  onSelectMember, onAddRelation, onRemoveRelation, onSetSync, focusedEpochId = null,
}: TeamFlowCanvasProps) {
  const colorMode = useColorMode()
  // Cartoon is a read-mode presentation; the structure editor stays on plain cards.
  const cartoon = useOfficeSkin(teamId) === 'cartoon' && !editable

  // Layout positions are STABLE during editing: dagre seeds them when the member
  // set changes (read mode also re-seeds when the structure changes); after that
  // the user can drag freely and adding/removing a link never reshuffles nodes.
  const memberSig = useMemo(() => roster.map(m => m.appId).sort().join(','), [roster])
  const edgeSig = useMemo(() => teamEdges.map(e => `${e.fromAppId}>${e.toAppId}`).sort().join(','), [teamEdges])
  const layoutKey = editable ? memberSig : `${memberSig}|${edgeSig}`

  const positions = useMemo(() => {
    // Sort before seeding dagre: roster insertion order differs per node, which
    // made the same office lay out differently on different machines.
    const ordered = [...roster].sort(
      (a, b) =>
        Number(b.isLead) - Number(a.isLead) ||
        a.memberName.localeCompare(b.memberName) ||
        a.appId.localeCompare(b.appId)
    )
    const base: MemberFlowNode[] = ordered.map(m => ({
      id: m.appId, type: 'member', position: { x: 0, y: 0 },
      data: { member: m, editable, teamId, active: false },
    }))
    // Free mode persists no edges, which would flatten everyone onto one rank —
    // seed layout-only lead→member links so the lead still sits above members.
    // Never rendered, never persisted.
    let layoutEdges = buildEdges(roster, teamEdges, [])
    const lead = ordered.find(m => m.isLead)
    if (layoutEdges.length === 0 && lead) {
      layoutEdges = ordered
        .filter(m => m.appId !== lead.appId)
        .map(m => styleEdge(`layout-${lead.appId}__${m.appId}`, lead.appId, m.appId, false, false))
    }
    const laid = layoutNodes(base, layoutEdges, cartoon ? NODE_H_CARTOON : NODE_H)
    return new Map(laid.map(n => [n.id, n.position]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey, cartoon])

  // ── Controlled mode: nodes/edges are always derived from props + local drag
  //    state. No useNodesState/useEdgesState — those had timing conflicts with
  //    React Flow's internal node measurement (visibility:hidden never resolved).
  //    This approach: derive → pass → render. React Flow measures what it gets.

  // Drag positions overlay (edit mode only; ephemeral within a session).
  const [dragPos, setDragPos] = useState(new Map<string, { x: number; y: number }>())
  // Selection (needed for NodeToolbar visibility on selected node).
  const [selNodeIds, setSelNodeIds] = useState(new Set<string>())
  const [selEdgeIds, setSelEdgeIds] = useState(new Set<string>())
  // Reset drag positions when layout changes (new members / mode switch).
  useEffect(() => { setDragPos(new Map()) }, [positions])

  const nodes = useMemo<MemberFlowNode[]>(() => roster.map(m => ({
    id: m.appId,
    type: 'member',
    position: dragPos.get(m.appId) ?? positions.get(m.appId) ?? { x: 0, y: 0 },
    data: { member: m, editable, teamId, active: activeFlows.some(f => f.fromAppId === m.appId || f.toAppId === m.appId), focusedEpochId },
    draggable: editable,
    selectable: true,
    selected: selNodeIds.has(m.appId),
  })), [roster, positions, dragPos, editable, teamId, activeFlows, selNodeIds, focusedEpochId])

  const edges = useMemo(() => {
    const base = buildEdges(roster, teamEdges, activeFlows)
    return base.map(e => selEdgeIds.has(e.id) ? { ...e, selected: true } : e)
  }, [roster, teamEdges, activeFlows, selEdgeIds])

  const handleNodesChange = useCallback((changes: NodeChange<MemberFlowNode>[]) => {
    for (const c of changes) {
      if (c.type === 'position' && 'position' in c && c.position) {
        setDragPos(prev => new Map(prev).set(c.id, c.position!))
      }
      if (c.type === 'select') {
        setSelNodeIds(prev => {
          const next = new Set(prev)
          if (c.selected) next.add(c.id); else next.delete(c.id)
          return next
        })
      }
      // 'dimensions' changes are handled internally by React Flow (measurement).
    }
  }, [])

  const handleEdgesChange = useCallback((changes: EdgeChange[]) => {
    for (const c of changes) {
      if (c.type === 'select') {
        setSelEdgeIds(prev => {
          const next = new Set(prev)
          if (c.selected) next.add(c.id); else next.delete(c.id)
          return next
        })
      }
    }
  }, [])

  const onConnect = useCallback((conn: Connection) => {
    if (!editable || !conn.source || !conn.target || conn.source === conn.target) return
    if (teamEdges.some(e => e.fromAppId === conn.source && e.toAppId === conn.target)) return
    onAddRelation?.(conn.source, conn.target, false)
  }, [editable, teamEdges, onAddRelation])

  const onNodeClick = useCallback<NodeMouseHandler>((_evt, node) => {
    if (editable) return
    const m = roster.find(r => r.appId === node.id)
    if (m) onSelectMember?.(m)
  }, [editable, roster, onSelectMember])

  const edit = useMemo<FlowEdit>(() => ({
    editable,
    roster,
    edges: teamEdges,
    addRelation: (f, t, s) => onAddRelation?.(f, t, s),
    removeRelation: (f, t) => onRemoveRelation?.(f, t),
    setSync: (f, t, s) => onSetSync?.(f, t, s),
  }), [editable, roster, teamEdges, onAddRelation, onRemoveRelation, onSetSync])

  return (
    <FlowEditContext.Provider value={edit}>
      <div className="relative h-full w-full">
        {/* Cartoon skin: a soft, uniform office wash behind the workstations.
            Uniform so it never breaks when the canvas pans/zooms. */}
        {cartoon && (
          <div
            className="pointer-events-none absolute inset-0"
            style={{ background: 'radial-gradient(130% 100% at 50% -10%, hsl(var(--secondary) / 0.18), transparent 55%)' }}
          />
        )}
        {cartoon && <OfficePlant />}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode={colorMode}
          fitView
          fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
          nodesDraggable={editable}
          nodesConnectable={editable}
          elementsSelectable
          edgesFocusable={editable}
          connectionLineType={ConnectionLineType.SmoothStep}
          connectionLineStyle={{ stroke: 'hsl(var(--primary))', strokeWidth: 2 }}
          proOptions={{ hideAttribution: true }}
          className="bg-transparent"
        >
          <Background gap={cartoon ? 24 : 16} size={1} className={cartoon ? 'opacity-20' : 'opacity-50'} />
          {editable && <Controls showInteractive={false} position="bottom-left" className="!shadow-md" />}
        </ReactFlow>
        {editable && <RelationshipsPanel />}
      </div>
    </FlowEditContext.Provider>
  )
}

export function TeamFlowCanvas(props: TeamFlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <InnerCanvas {...props} />
    </ReactFlowProvider>
  )
}
