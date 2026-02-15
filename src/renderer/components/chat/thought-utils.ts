/**
 * Thought Utilities - Shared utilities for thought display components
 *
 * Provides consistent styling, icons, labels and formatting for thought items
 * across ThoughtProcess (real-time) and CollapsedThoughtProcess (history) components.
 */

import {
  Lightbulb,
  Braces,
  CheckCircle2,
  MessageSquare,
  Info,
  XCircle,
  Sparkles,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { getToolIcon } from '../icons/ToolIcons'
import type { Thought } from '../../types'

// i18n static keys for extraction (DO NOT REMOVE)
// prettier-ignore
void function _i18nThoughtKeys(t: (k: string) => string) {
  t('Thinking'); t('Tool call'); t('Tool result'); t('System'); t('Error'); t('Complete')
}

// ============================================
// Text Utilities
// ============================================

/**
 * Truncate text with ellipsis if exceeds max length
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.substring(0, maxLength - 1) + '…'
}

// ============================================
// Thought Type Styling
// ============================================

/**
 * Get icon component for thought type
 *
 * @param type - Thought type
 * @param toolName - Optional tool name for tool_use type (uses tool-specific icon)
 * @returns LucideIcon component
 */
export function getThoughtIcon(type: Thought['type'], toolName?: string): LucideIcon {
  switch (type) {
    case 'thinking':
      return Lightbulb
    case 'tool_use':
      return toolName ? getToolIcon(toolName) : Braces
    case 'tool_result':
      return CheckCircle2
    case 'text':
      return MessageSquare
    case 'system':
      return Info
    case 'error':
      return XCircle
    case 'result':
      return Sparkles
    default:
      return Zap
  }
}

/**
 * Get Tailwind color class for thought type
 *
 * @param type - Thought type
 * @param isError - Override to show error color
 * @returns Tailwind color class string
 */
export function getThoughtColor(type: Thought['type'], isError?: boolean): string {
  // Tool errors use amber (warning) instead of red (destructive) because
  // they are internal AI feedback, not user-facing errors
  if (isError) return 'text-amber-500'

  switch (type) {
    case 'thinking':
      return 'text-blue-400'
    case 'tool_use':
      return 'text-amber-400'
    case 'tool_result':
      return 'text-green-400'
    case 'text':
      return 'text-foreground'
    case 'system':
      return 'text-muted-foreground'
    case 'error':
      return 'text-destructive'
    case 'result':
      return 'text-primary'
    default:
      return 'text-muted-foreground'
  }
}

/**
 * Get display label for thought type
 *
 * @param type - Thought type
 * @returns Display label string (English, not translated)
 */
export function getThoughtLabelKey(type: Thought['type']): string {
  switch (type) {
    case 'thinking':
      return 'Thinking'
    case 'tool_use':
      return 'Tool call'
    case 'tool_result':
      return 'Tool result'
    case 'text':
      return 'AI'
    case 'system':
      return 'System'
    case 'error':
      return 'Error'
    case 'result':
      return 'Complete'
    default:
      return 'AI'
  }
}

// ============================================
// Tool Input Formatting
// ============================================

/**
 * Format tool input into human-readable summary
 *
 * Transforms raw tool parameters into friendly descriptions:
 * - Read: shows file path
 * - Bash: shows command
 * - WebFetch: shows domain name
 * - etc.
 *
 * @param toolName - Name of the tool
 * @param toolInput - Tool input parameters
 * @returns Human-readable summary string
 */
export function getToolFriendlyFormat(
  toolName: string,
  toolInput?: Record<string, unknown>
): string {
  if (!toolInput) return ''

  switch (toolName) {
    case 'Bash':
      return typeof toolInput.command === 'string' ? toolInput.command : ''

    case 'Read':
      return typeof toolInput.file_path === 'string' ? toolInput.file_path : ''

    case 'Write':
      return typeof toolInput.file_path === 'string' ? `${toolInput.file_path} (new)` : ''

    case 'Edit':
      return typeof toolInput.file_path === 'string' ? `${toolInput.file_path} (edit)` : ''

    case 'Grep': {
      const pattern = typeof toolInput.pattern === 'string' ? `"${toolInput.pattern}"` : ''
      const path = typeof toolInput.path === 'string' ? ` in ${toolInput.path}` : ''
      return `Search ${pattern}${path}`
    }

    case 'Glob':
      return typeof toolInput.pattern === 'string' ? `Match ${toolInput.pattern}` : ''

    case 'WebFetch': {
      if (typeof toolInput.url === 'string') {
        try {
          return new URL(toolInput.url).hostname.replace('www.', '')
        } catch {
          return toolInput.url
        }
      }
      return ''
    }

    case 'WebSearch':
      return typeof toolInput.query === 'string' ? `Search: ${toolInput.query}` : ''

    case 'Task':
      return typeof toolInput.description === 'string' ? toolInput.description : ''

    case 'NotebookEdit':
      return typeof toolInput.notebook_path === 'string' ? toolInput.notebook_path : ''

    default:
      // Fallback: show first non-empty string value
      for (const value of Object.values(toolInput)) {
        if (typeof value === 'string' && value.length > 0) {
          return truncateText(value, 80)
        }
      }
      return ''
  }
}
