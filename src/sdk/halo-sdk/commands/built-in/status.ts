/**
 * /status — composite status report.
 *
 * Surfaces version-ish identifiers (model, cwd, session id) plus MCP
 * connectivity. The SDK does not own a "version" concept distinct from
 * the host, so we omit that field rather than fabricate one.
 */

import type { Command, SlashCommandContext, SlashCommandResult } from '../types.js';

const status: Command = {
  type: 'local',
  name: 'status',
  description:
    'Inspect this session, its model and working directory, history size, and MCP connections',
  source: 'builtin',
  async call(_args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> {
    let md = `## Status\n\n`;
    md += `**Session:** \`${ctx.sessionId}\`  \n`;
    md += `**Model:** \`${ctx.model}\`  \n`;
    md += `**Working directory:** \`${ctx.cwd}\`  \n`;
    md += `**Messages in history:** ${ctx.messages.length}\n\n`;

    md += `### MCP servers\n\n`;
    if (ctx.mcpServerStatuses.length === 0) {
      md += `_No MCP servers configured._\n`;
    } else {
      md += `| Name | Status |\n|------|--------|\n`;
      for (const s of ctx.mcpServerStatuses) {
        md += `| ${s.name} | ${s.status} |\n`;
      }
    }

    return { kind: 'system', markdown: md };
  },
};

export default status;
