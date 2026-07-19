/**
 * SortableSpaceList — drag-to-reorder wrapper for space lists.
 *
 * Wraps a list of Space items in a dnd-kit DndContext + SortableContext.
 * The whole row/card is the drag target: PointerSensor activates after a
 * 6px move (so plain clicks still select), TouchSensor after a 250ms
 * long-press (so mobile scrolling is not hijacked). On drag end, calls
 * onReorder with the new id order.
 *
 * Render strategy: rectSortingStrategy supports both single-column and
 * multi-column (e.g. 2-col grid) layouts — the parent decides layout via
 * the wrapper className; this component only owns the drag wiring.
 *
 * IMPORTANT: the sortable wrapper node must stay free of CSS transitions
 * (e.g. `.space-card` has `transition: all`) — dnd-kit drives its
 * `transform` per-frame, and any CSS transition on the same node makes
 * the dragged item lag behind the pointer. Card styling belongs inside
 * `renderItem`.
 */

import { useState, type ReactNode } from 'react'
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  arrayMove,
  useSortable,
  rectSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Space } from '../../types'

interface SortableSpaceListProps {
  items: Space[]
  onReorder: (spaceIds: string[]) => void
  /** Render the full row/card for a single space. The whole output is draggable. */
  renderItem: (space: Space) => ReactNode
  /** Class applied to the list wrapper (controls layout: grid/flex/cols). */
  className?: string
}

export function SortableSpaceList({
  items,
  onReorder,
  renderItem,
  className,
}: SortableSpaceListProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const [activeId, setActiveId] = useState<string | null>(null)

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    setActiveId(null)
    if (!over || active.id === over.id) return
    const oldIndex = items.findIndex(s => s.id === active.id)
    const newIndex = items.findIndex(s => s.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    const next = arrayMove(items, oldIndex, newIndex)
    onReorder(next.map(s => s.id))
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={(e) => setActiveId(String(e.active.id))}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <SortableContext items={items.map(s => s.id)} strategy={rectSortingStrategy}>
        <div className={className}>
          {items.map(space => (
            <SortableSpaceRow
              key={space.id}
              space={space}
              isDragging={activeId === space.id}
              renderItem={renderItem}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}

interface SortableSpaceRowProps {
  space: Space
  isDragging: boolean
  renderItem: (space: Space) => ReactNode
}

function SortableSpaceRow({ space, isDragging, renderItem }: SortableSpaceRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging: isSortableDragging,
  } = useSortable({ id: space.id })

  const dragging = isDragging || isSortableDragging

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        // dnd-kit's own transition only (item shuffle animation); while
        // actively dragging it is undefined so the node tracks the pointer.
        transition,
        zIndex: dragging ? 10 : undefined,
        position: 'relative',
      }}
      className={dragging ? 'opacity-60' : undefined}
      {...attributes}
      {...listeners}
    >
      {renderItem(space)}
    </div>
  )
}
