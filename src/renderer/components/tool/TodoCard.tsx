/**
 * TodoCard - Visual representation of AI task planning
 * Displays todo items created by TodoWrite tool in a clear, intuitive checklist format
 *
 * Design principles:
 * - Simple and intuitive - users see a familiar task list
 * - Non-intrusive - appears naturally in the thought flow
 * - Real-time updates - status changes animate smoothly
 */

import { useMemo } from 'react'
import {
  Circle,
  CheckCircle2,
  Loader2,
  ListTodo,
} from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { TodoItem, TodoStatus } from '../../utils/thought-activity'

// Note: Loader2 is used for in_progress task icon animation

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
        color: 'text-muted-foreground/50',
        bgColor: 'bg-transparent',
        textStyle: 'text-muted-foreground',
      }
    case 'in_progress':
      return {
        Icon: Loader2,
        color: 'text-primary',
        bgColor: 'bg-primary/10',
        textStyle: 'text-foreground font-medium',
        spin: true,
      }
    case 'completed':
      return {
        Icon: CheckCircle2,
        color: 'text-green-500',
        bgColor: 'bg-green-500/10',
        textStyle: 'text-muted-foreground line-through',
      }
  }
}

// Single todo item
function TodoItemRow({ item, index, isAgentActive = true }: { item: TodoItem; index: number; isAgentActive?: boolean }) {
  const display = getTodoStatusDisplay(item.status)
  const Icon = display.Icon

  // Detect interrupted state: agent stopped but todo still in_progress
  const isInterrupted = !isAgentActive && item.status === 'in_progress'

  // Show activeForm when in progress, otherwise show content
  const displayText = item.status === 'in_progress' && item.activeForm
    ? item.activeForm
    : item.content

  return (
    <div
      className={`
        flex items-start gap-3 px-3 py-2 rounded-lg transition-all duration-200
        ${isInterrupted ? 'bg-amber-500/10' : display.bgColor}
        ${item.status === 'in_progress' && !isInterrupted ? 'animate-fade-in' : ''}
      `}
    >
      <Icon
        size={16}
        className={`
          flex-shrink-0 mt-0.5
          ${isInterrupted ? 'text-amber-500' : display.color}
          ${display.spin && !isInterrupted ? 'animate-spin' : ''}
        `}
      />
      <span className={`text-sm leading-relaxed ${isInterrupted ? 'text-amber-600 dark:text-amber-400' : display.textStyle}`}>
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
    const inProgress = todos.filter(t => t.status === 'in_progress').length
    const pending = todos.filter(t => t.status === 'pending').length
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0

    return { total, completed, inProgress, pending, progress }
  }, [todos])

  if (todos.length === 0) {
    return null
  }

  return (
    <div className="animate-fade-in">
      <div className="rounded-xl border border-border-faint bg-card/50 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/30 bg-secondary/20">
          <div className="flex items-center gap-2">
            <ListTodo size={16} className="text-primary" />
            <span className="text-sm font-medium text-foreground">{t('Task plan')}</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {stats.completed > 0 && (
              <span className="text-green-500">{t('{{count}} completed', { count: stats.completed })}</span>
            )}
            {stats.inProgress > 0 && (
              <span className="text-primary">{t('{{count}} in progress', { count: stats.inProgress })}</span>
            )}
            {stats.pending > 0 && (
              <span>{t('{{count}} pending', { count: stats.pending })}</span>
            )}
          </div>
        </div>

        {/* Progress bar */}
        {stats.total > 0 && (
          <div className="h-1 bg-secondary/30">
            <div
              className="h-full bg-green-500 transition-all duration-500 ease-out"
              style={{ width: `${stats.progress}%` }}
            />
          </div>
        )}

        {/* Todo items */}
        <div className="p-2 space-y-1">
          {todos.map((item, index) => (
            <TodoItemRow key={index} item={item} index={index} isAgentActive={isAgentActive} />
          ))}
        </div>

      </div>
    </div>
  )
}
