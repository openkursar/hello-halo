/**
 * Dagre auto-layout for the team flow canvas.
 *
 * React Flow renders + handles interaction; it does not position nodes. We use
 * dagre (the same layered DAG engine behind most node-graph UIs) to compute
 * crossing-minimized coordinates, so any topology — hub-spoke, chains,
 * member-to-member edges — lays out cleanly instead of overlapping.
 */

import dagre from '@dagrejs/dagre'
import type { Node, Edge } from '@xyflow/react'

export const NODE_W = 200
export const NODE_H = 76
/** The cartoon workstation card is taller (scene + body); dagre needs its real
 *  height so vertically-stacked ranks don't overlap. */
export const NODE_H_CARTOON = 200

/**
 * Assign positions to `nodes` from the `edges` using a top-to-bottom layered
 * layout. Returns a new array (does not mutate). The lead naturally rises to the
 * top rank because edges flow lead → members.
 *
 * `nodeH` is the rendered node height fed to dagre (defaults to the plain card);
 * pass the cartoon height when that skin is active so ranks keep clear of each
 * other.
 */
export function layoutNodes<T extends Node>(nodes: T[], edges: Edge[], nodeH: number = NODE_H): T[] {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 48, ranksep: 72, marginx: 16, marginy: 16 })
  g.setDefaultEdgeLabel(() => ({}))

  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: nodeH })
  for (const e of edges) {
    if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target)
  }

  dagre.layout(g)

  return nodes.map((n) => {
    const p = g.node(n.id)
    // dagre returns the node center; React Flow positions by top-left.
    return { ...n, position: { x: p.x - NODE_W / 2, y: p.y - nodeH / 2 } }
  })
}
