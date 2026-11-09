/**
 * /cost — session cost report.
 *
 * Reads {@link SlashCommandContext.getCostSnapshot} and renders a
 * markdown summary of session-lifetime spend, duration and token usage.
 *
 * Caveat: only completed turns contribute to the snapshot. The current
 * in-flight turn (the one carrying this `/cost` invocation) has not yet
 * emitted its `result` event, so its tokens / cost are not yet
 * aggregated. We surface that explicitly when `numTurns === 0`.
 */

import type { Command, SlashCommandContext, SlashCommandResult } from '../types.js';

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)} s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}m ${rem.toFixed(1)}s`;
}

const cost: Command = {
  type: 'local',
  name: 'cost',
  description: 'Report spending, elapsed time, and token counts accumulated from completed turns',
  source: 'builtin',
  async call(_args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> {
    const s = ctx.getCostSnapshot();
    let md = `## Session cost\n\n`;
    md += `**Total cost:** ${fmtUsd(s.totalCostUsd)}  \n`;
    md += `**Duration (wall):** ${fmtMs(s.totalDurationMs)}  \n`;
    md += `**Duration (API):** ${fmtMs(s.totalApiDurationMs)}  \n`;
    md += `**Turns counted:** ${s.numTurns}\n\n`;
    md += `### Tokens\n\n`;
    md += `| Bucket | Count |\n|--------|------:|\n`;
    md += `| Input | ${s.tokens.input.toLocaleString()} |\n`;
    md += `| Output | ${s.tokens.output.toLocaleString()} |\n`;
    md += `| Cache create | ${s.tokens.cacheCreate.toLocaleString()} |\n`;
    md += `| Cache read | ${s.tokens.cacheRead.toLocaleString()} |\n`;
    if (s.numTurns === 0) {
      md += `\n_The current in-flight turn is not yet aggregated — totals will update once it completes._\n`;
    }
    return { kind: 'system', markdown: md };
  },
};

export default cost;
