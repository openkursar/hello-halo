/**
 * Server ids the automation runtime injects as built-in capabilities, as
 * opposed to external installable MCP apps. Source of truth is the mcpServers
 * literals in apps/runtime/execute.ts and app-chat.ts — sync is enforced by
 * tests/unit/shared/builtin-mcp.test.ts.
 *
 * 'email' is the permission-name alias spec authors sometimes write in
 * requires.mcps for the 'halo-email' server.
 */
export const BUILTIN_MCP_SERVER_IDS: ReadonlySet<string> = new Set([
  'ai-browser', 'ai-terminal', 'email', 'halo-email',
  'web-search', 'halo-memory', 'halo-report', 'halo-notify',
  'halo-apps', 'im-file-send',
])
