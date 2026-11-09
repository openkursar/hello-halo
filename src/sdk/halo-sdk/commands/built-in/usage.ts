/**
 * /usage — token-usage report.
 *
 * The SDK does not own subscription/limits state (those live in the host
 * auth layer). What we CAN report from `getCostSnapshot()` is the
 * current session's cumulative token usage and turn count, which is the
 * useful signal for SDK consumers running on a direct API key.
 *
 * If subscription-tier limit data is later exposed via ctx, this handler
 * should layer it on top of the per-session totals shown here.
 */

import type { Command, SlashCommandContext, SlashCommandResult } from '../types.js';

const usage: Command = {
  type: 'local',
  name: 'usage',
  description: 'Report token totals and completed turns for this session',
  source: 'builtin',
  async call(_args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> {
    const s = ctx.getCostSnapshot();
    const totalTokens =
      s.tokens.input + s.tokens.output + s.tokens.cacheCreate + s.tokens.cacheRead;

    let md = `## Session usage\n\n`;
    md += `**Turns:** ${s.numTurns}  \n`;
    md += `**Total tokens:** ${totalTokens.toLocaleString()}\n\n`;
    md += `| Bucket | Count |\n|--------|------:|\n`;
    md += `| Input | ${s.tokens.input.toLocaleString()} |\n`;
    md += `| Output | ${s.tokens.output.toLocaleString()} |\n`;
    md += `| Cache create | ${s.tokens.cacheCreate.toLocaleString()} |\n`;
    md += `| Cache read | ${s.tokens.cacheRead.toLocaleString()} |\n`;
    md += `\n_Subscription-tier limits and reset windows are not surfaced by the SDK — refer to your provider dashboard for quota state._\n`;
    return { kind: 'system', markdown: md };
  },
};

export default usage;
