/**
 * /mcp — MCP server connection status.
 *
 * Reads {@link SlashCommandContext.mcpServerStatuses} and renders a
 * markdown table. When no servers are configured we emit a one-line
 * notice instead of an empty table.
 */

import type { Command, SlashCommandContext, SlashCommandResult } from '../types.js';

const mcp: Command = {
  type: 'local',
  name: 'mcp',
  description: 'Show MCP server connection status',
  source: 'builtin',
  async call(_args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> {
    const servers = ctx.mcpServerStatuses;
    if (servers.length === 0) {
      return { kind: 'system', markdown: 'No MCP servers configured.' };
    }
    let md = `## MCP servers\n\n| Name | Status |\n|------|--------|\n`;
    for (const s of servers) {
      md += `| ${s.name} | ${s.status} |\n`;
    }
    return { kind: 'system', markdown: md };
  },
};

export default mcp;
