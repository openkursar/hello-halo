/**
 * RelationEdge — a collaboration link, render-only.
 *
 * Solid = sync (waits for reply), dashed = async; it thickens when selected and
 * animates while a message flows across it. All editing (add / remove / toggle
 * sync) is done through visible controls elsewhere — the floating relationships
 * panel and the node's "connect to…" toolbar — so the edge itself has no hidden
 * click gestures.
 */

import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/react'

interface RelationEdgeData {
  sync?: boolean
  active?: boolean
  [key: string]: unknown
}

export function RelationEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, markerEnd, id } = props
  const data = props.data as RelationEdgeData | undefined
  const sync = Boolean(data?.sync)
  const active = Boolean(data?.active)

  const [path] = getSmoothStepPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 10,
  })

  const stroke = active
    ? 'hsl(var(--primary))'
    : selected
      ? 'hsl(var(--primary))'
      : sync
        ? 'hsl(var(--primary) / 0.65)'
        : 'hsl(var(--muted-foreground) / 0.6)'

  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      interactionWidth={28}
      style={{
        stroke,
        strokeWidth: selected ? 3 : active ? 2.5 : 1.6,
        strokeDasharray: sync ? undefined : '6 5',
      }}
    />
  )
}
