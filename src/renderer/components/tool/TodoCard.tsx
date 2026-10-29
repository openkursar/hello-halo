/**
 * TodoCard - Visual representation of AI task planning
 * Displays todo items created by TodoWrite tool in a clear, intuitive checklist format
 *
 * Design principles:
 * - Simple and intuitive - users see a familiar task list
 * - Non-intrusive - appears naturally in the thought flow
 * - Real-time updates - status changes animate smoothly
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Circle,
  CheckCircle2,
  Loader2,
  ListTodo,
} from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { TodoItem, TodoStatus } from '../../utils/thought-activity'

// Note: Loader2 is used for in_progress task icon animation

/** How long a just-completed item keeps its green tint before fading back. */
const COMPLETE_FLASH_MS = 600

interface TodoCardProps {
  todos: TodoItem[]
  isAgentActive?: boolean  // When false and todo is in_progress, show interrupted state
}

// Get icon and style for todo status
function getTodoStatusDisplay(status: TodoStatus) {
  switch (status) {
    case 'pending':
      return {
        Icon: Circle,
        color: 'text-faint-foreground/70',
        bgColor: 'bg-transparent',
        textStyle: 'text-foreground/80',
      }
    case 'in_progress':
      return {
        Icon: Loader2,
        color: 'text-primary',
        bgColor: 'bg-primary/[0.08]',
        textStyle: 'text-foreground font-semibold',
        spin: true,
      }
    case 'completed':
      return {
        Icon: CheckCircle2,
        color: 'text-halo-success',
        bgColor: 'bg-transparent',
        // The check already says done; a strikethrough would read as cancelled, and the
        // finished list is the turn's summary, so it stays readable.
        textStyle: 'text-muted-foreground',
      }
  }
}

// Single todo item
function TodoItemRow({ item, index, isAgentActive = true }: { item: TodoItem; index: number; isAgentActive?: boolean }) {
  const display = getTodoStatusDisplay(item.status)
  const Icon = display.Icon

  // Detect interrupted state: agent stopped but todo still in_progress
  const isInterrupted = !isAgentActive && item.status === 'in_progress'

  // Marks the moment an item completes in view; a list that mounts already done stays still.
  const prevStatus = useRef(item.status)
  const [justCompleted, setJustCompleted] = useState(false)
  useEffect(() => {
    const was = prevStatus.current
    prevStatus.current = item.status
    if (was === item.status || item.status !== 'completed') return
    setJustCompleted(true)
    const timer = setTimeout(() => setJustCompleted(false), COMPLETE_FLASH_MS)
    return () => clearTimeout(timer)
  }, [item.status])

  // Show activeForm when in progress, otherwise show content
  const displayText = item.status === 'in_progress' && item.activeForm
    ? item.activeForm
    : item.content

  return (
    <div
      className={`
        flex items-start gap-2 -mx-1.5 px-1.5 py-1 rounded-md transition-colors duration-500
        ${isInterrupted ? 'bg-amber-500/10' : justCompleted ? 'bg-halo-success/10' : display.bgColor}
        ${item.status === 'in_progress' && !isInterrupted ? 'animate-fade-in' : ''}
      `}
    >
      {/* A box one text line tall centers the icon on the first line, however the title wraps. */}
      <span className="flex h-[1.625em] flex-shrink-0 items-center text-[13px]">
        <Icon
          size={14}
          className={`
            ${isInterrupted ? 'text-amber-500' : display.color}
            ${display.spin && !isInterrupted ? 'animate-spin' : ''}
            ${justCompleted ? 'todo-check-pop' : ''}
          `}
        />
      </span>
      <span className={`text-[13px] leading-relaxed ${isInterrupted ? 'text-amber-600 dark:text-amber-400' : display.textStyle}`}>
        {displayText}
      </span>
    </div>
  )
}

export function TodoCard({ todos, isAgentActive = true }: TodoCardProps) {
  const { t } = useTranslation()
  // Calculate progress stats
  const stats = useMemo(() => {
    const total = todos.length
    const completed = todos.filter(t => t.status === 'completed').length
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0

    return { total, completed, progress }
  }, [todos])

  if (todos.length === 0) {
    return null
  }

  return (
    <div className="animate-fade-in">
      {/* A soft fill, not a bordered card: it sits inside the thought panel's own box. */}
      <div className="rounded-lg bg-secondary/55 px-3 pt-2.5 pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ListTodo size={14} className="text-muted-foreground" />
            <span className="text-[13px] font-semibold text-foreground">{t('Task plan')}</span>
          </div>
          {/* One progress figure; which item is running, and which wait, the list itself shows. */}
          <span className="text-xs tabular-nums text-muted-foreground">
            <span className={stats.completed > 0 ? 'text-halo-success' : ''}>{stats.completed}</span>/{stats.total}
          </span>
        </div>

        {/* Progress bar — only once something is done; an empty track reads as a divider. */}
        {stats.completed > 0 ? (
          <div className="h-0.5 rounded-full bg-border mt-2 mb-1.5 overflow-hidden">
            <div
              className="h-full bg-halo-success transition-all duration-500 ease-out"
              style={{ width: `${stats.progress}%` }}
            />
          </div>
        ) : (
          // The bar's own height and margins, so the list does not move when it appears.
          <div className="h-0.5 mt-2 mb-1.5" />
        )}

        {/* Todo items */}
        <div className="space-y-0.5">
          {todos.map((item, index) => (
            <TodoItemRow key={index} item={item} index={index} isAgentActive={isAgentActive} />
          ))}
        </div>

      </div>
    </div>
  )
}
