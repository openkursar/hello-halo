/**
 * Agent Stream Constants
 *
 * Shared constants for stream processing and event replay.
 * Imported by both stream-processor.ts (real-time) and
 * apps/runtime/session-store.ts (offline replay) to guarantee
 * identical behaviour across both paths.
 */

import {
  SPACE_TEAM_TOOL_NAMES,
  TEAM_MCP_SERVER_NAME,
  TEAM_TOOL_NAMES,
} from '../../../shared/apps/team-types'

/** Built-in tools that carry no user-visible output — pure bookkeeping. */
const TRANSPARENT_BUILTIN_TOOLS = new Set<string>([
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
])

/**
 * Team tools that are coordination bookkeeping rather than work the user is
 * waiting to read. Deliberately excludes the ones whose result IS the answer —
 * `team_read_artifact` (opens a deliverable), `team_run`, `team_list`,
 * `team_status` — where the text before really is "let me go look".
 */
const TRANSPARENT_TEAM_TOOLS = new Set<string>([
  TEAM_TOOL_NAMES.send,
  TEAM_TOOL_NAMES.postTask,
  TEAM_TOOL_NAMES.updateTask,
  TEAM_TOOL_NAMES.postFinding,
  TEAM_TOOL_NAMES.readBoard,
  TEAM_TOOL_NAMES.complete,
  TEAM_TOOL_NAMES.schedule,
  TEAM_TOOL_NAMES.unschedule,
  SPACE_TEAM_TOOL_NAMES.collabStart,
  SPACE_TEAM_TOOL_NAMES.collabSave,
])

const TEAM_TOOL_PREFIX = `mcp__${TEAM_MCP_SERVER_NAME}__`

/**
 * Whether a tool preserves text continuity between consecutive text blocks.
 *
 * When only transparent tools appear between two text blocks, the blocks are
 * concatenated into a single message bubble. All other tools are "substantive":
 * they signal a context shift, so the text before them is treated as
 * transitional and the next text block starts fresh.
 *
 * The name arrives as the engine reports it, so MCP tools are prefixed
 * (`mcp__halo-team__team_complete`). The prefix is stripped only for the team
 * server — matching bare names alone would let an unrelated server's
 * same-named tool through.
 */
export function isTransparentTool(toolName: string): boolean {
  if (TRANSPARENT_BUILTIN_TOOLS.has(toolName)) return true
  if (!toolName.startsWith(TEAM_TOOL_PREFIX)) return false
  return TRANSPARENT_TEAM_TOOLS.has(toolName.slice(TEAM_TOOL_PREFIX.length))
}
