/**
 * /help — list all user-invocable commands available in this session.
 *
 * Reads {@link SlashCommandContext.commands}, which is already filtered
 * through `filterUserInvocable`. This includes built-ins plus any
 * user-supplied or skill overlays — handlers should NOT re-import
 * BUILT_IN_COMMANDS here, as that would miss those overlays.
 */

import type { Command, SlashCommandContext, SlashCommandResult } from '../types.js';
import { getCommandName } from '../types.js';

const help: Command = {
  type: 'local',
  name: 'help',
  description: 'List callable session commands with their argument hints and descriptions',
  source: 'builtin',
  async call(_args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> {
    let md = `## Available commands\n\n`;
    if (ctx.commands.length === 0) {
      md += `_No commands registered._\n`;
      return { kind: 'system', markdown: md };
    }
    for (const cmd of ctx.commands) {
      const hint = cmd.argumentHint ? ` ${cmd.argumentHint}` : '';
      md += `- \`/${getCommandName(cmd)}${hint}\` — ${cmd.description}\n`;
    }
    return { kind: 'system', markdown: md };
  },
};

export default help;
