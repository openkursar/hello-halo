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
// Sub-agent grouping
// ============================================

export const NO_CHILD_THOUGHTS: Thought[] = []

/**
 * Sub-agent steps grouped under their parent Task/Agent step id. A parent whose
 * steps did not change keeps its array from `previous`, so its memoized row is
 * not re-rendered when an unrelated step streams in.
 */
export function groupChildThoughts(
  thoughts: readonly Thought[],
  previous?: ReadonlyMap<string, Thought[]>,
): Map<string, Thought[]> {
  const groups = new Map<string, Thought[]>()
  for (const thought of thoughts) {
    if (!thought.parentToolUseId) continue
    const group = groups.get(thought.parentToolUseId)
    if (group) group.push(thought)
    else groups.set(thought.parentToolUseId, [thought])
  }
  if (previous) {
    for (const [parentId, group] of groups) {
      const before = previous.get(parentId)
      if (before && before.length === group.length && before.every((thought, i) => thought === group[i])) {
        groups.set(parentId, before)
      }
    }
  }
  return groups
}

// ============================================
// Live panel model
// ============================================

/** What the live thought panel draws, derived from a turn's steps. */
export interface ThoughtPanelModel {
  /** The steps it was derived from. */
  readonly thoughts: readonly Thought[]
  /** Timeline steps: no results, no sub-agent steps (nested under their Task), no TodoWrite (one card below). */
  readonly display: readonly Thought[]
  /** Sub-agent steps by parent step id (see `groupChildThoughts`). */
  readonly childGroups: ReadonlyMap<string, Thought[]>
  /** The latest TodoWrite call that carries its input. */
  readonly latestTodo: Thought | null
  /** System errors; tool failures are part of normal investigation and not counted. */
  readonly errorCount: number
}

function isTimelineStep(thought: Thought): boolean {
  return thought.type !== 'result' && thought.type !== 'tool_result' && !thought.parentToolUseId && thought.toolName !== 'TodoWrite'
}

function isTodoCall(thought: Thought): boolean {
  return thought.type === 'tool_use' && thought.toolName === 'TodoWrite' && !!thought.toolInput
}

/** Whether `next` can replace `prev` without entering or leaving any derived list. */
function samePlace(prev: Thought, next: Thought): boolean {
  return prev.id === next.id && prev.type === next.type && prev.toolName === next.toolName
    && prev.parentToolUseId === next.parentToolUseId && isTodoCall(prev) === isTodoCall(next)
}

function buildThoughtPanelModel(thoughts: readonly Thought[], previousGroups?: ReadonlyMap<string, Thought[]>): ThoughtPanelModel {
  let latestTodo: Thought | null = null
  let errorCount = 0
  for (const thought of thoughts) {
    if (isTodoCall(thought)) latestTodo = thought
    if (thought.type === 'error') errorCount++
  }
  return {
    thoughts,
    display: thoughts.filter(isTimelineStep),
    childGroups: groupChildThoughts(thoughts, previousGroups),
    latestTodo,
    errorCount,
  }
}

/**
 * The panel model for `thoughts`, re-deriving only the steps that changed
 * since `prev`. Steps are appended or replaced in place by a new object (a
 * streamed delta, a tool result), so a step that kept its identity needs no
 * work. A step that changed kind, or a shorter list, rebuilds the model. `prev`
 * is never modified, and unchanged lists keep their identity.
 */
export function nextThoughtPanelModel(prev: ThoughtPanelModel | null, thoughts: readonly Thought[]): ThoughtPanelModel {
  if (prev?.thoughts === thoughts) return prev
  if (!prev || thoughts.length < prev.thoughts.length) return buildThoughtPanelModel(thoughts, prev?.childGroups)

  let display: Thought[] | null = null
  let groups: Map<string, Thought[]> | null = null
  let latestTodo = prev.latestTodo
  let errorCount = prev.errorCount
  const editDisplay = (): Thought[] => (display ??= [...prev.display])
  const editGroup = (parentId: string): Thought[] => {
    groups ??= new Map(prev.childGroups)
    const group = groups.get(parentId)
    if (group && group !== prev.childGroups.get(parentId)) return group
    const copy = group ? [...group] : []
    groups.set(parentId, copy)
    return copy
  }

  for (let i = 0; i < prev.thoughts.length; i++) {
    const before = prev.thoughts[i]
    const after = thoughts[i]
    if (after === before) continue
    if (!samePlace(before, after)) return buildThoughtPanelModel(thoughts, prev.childGroups)
    if (isTimelineStep(after)) {
      const list = editDisplay()
      list[list.lastIndexOf(before)] = after
    } else if (after.parentToolUseId) {
      const group = editGroup(after.parentToolUseId)
      group[group.lastIndexOf(before)] = after
    }
    if (latestTodo === before) latestTodo = after
  }

  for (let i = prev.thoughts.length; i < thoughts.length; i++) {
    const thought = thoughts[i]
    if (isTimelineStep(thought)) editDisplay().push(thought)
    else if (thought.parentToolUseId) editGroup(thought.parentToolUseId).push(thought)
    if (isTodoCall(thought)) latestTodo = thought
    if (thought.type === 'error') errorCount++
  }

  return { thoughts, display: display ?? prev.display, childGroups: groups ?? prev.childGroups, latestTodo, errorCount }
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
      if (toolInput.subagent_type === 'web-searcher') {
        return typeof toolInput.prompt === 'string' ? `Search: ${toolInput.prompt}` : 'Web search'
      }
      return typeof toolInput.description === 'string' ? toolInput.description : ''

    case 'NotebookEdit':
      return typeof toolInput.notebook_path === 'string' ? toolInput.notebook_path : ''

    case 'Goal':
      if (typeof toolInput.objective === 'string') return toolInput.objective
      return typeof toolInput.note === 'string' ? toolInput.note : ''

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
