/**
 * TaskStatusDot - Reusable animated status indicator dot
 * Used in ConversationList, ChatHistoryPanel, and SidebarToggle
 */

import type { TaskStatus } from '../../types'

interface TaskStatusDotProps {
  status: TaskStatus
  size?: 'sm' | 'md'
  className?: string
}

const STATUS_CLASS: Record<Exclude<TaskStatus, 'idle'>, string> = {
  'generating': 'pulse-dot-generating',
  'waiting': 'pulse-dot-waiting',
  'completed-unseen': 'pulse-dot-completed',
  'error': 'pulse-dot-error',
}

export function TaskStatusDot({ status, size = 'sm', className = '' }: TaskStatusDotProps) {
  const dimension = size === 'sm' ? 6 : 8

  // Idle: render invisible placeholder to preserve alignment
  if (status === 'idle') {
    return <span style={{ width: dimension, height: dimension }} className={`inline-block flex-shrink-0 ${className}`} />
  }

  return (
    <span
      className={`pulse-dot ${STATUS_CLASS[status]} ${className}`}
      style={{ width: dimension, height: dimension }}
      aria-label={status}
    />
  )
}
