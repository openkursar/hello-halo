/**
 * Default disabled tools — single source of truth.
 *
 * Shared between:
 *   - src/main/services/agent/sdk-config.ts (builds disallowedTools for SDK)
 *   - src/renderer/components/settings/AdvancedSection.tsx (UI toggles)
 *
 * These are optional capabilities that consume tokens but are rarely needed
 * in Halo's visual environment:
 *
 * - NotebookEdit: Jupyter notebook editing
 * - EnterPlanMode/ExitPlanMode: CLI-style planning workflow
 * - EnterWorktree/ExitWorktree: Git worktree isolation
 * - CronCreate/CronDelete/CronList: Built-in cron (Halo has halo-apps)
 * - WebSearch: Built-in web search (Halo has MCP web-search)
 */
export const DEFAULT_DISABLED_TOOLS = [
  'NotebookEdit',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
  'CronCreate',
  'CronDelete',
  'CronList',
  'WebSearch',
] as const

/** Native CC Team tools; Halo exposes collaboration through the halo-team MCP server. */
export const TEAM_TOOLS = ['TeamCreate', 'TeamDelete', 'SendMessage'] as const
