/**
 * /context — minimal context-usage report (a markdown table).
 *
 * Reports model, message count, and a coarse char-based size estimate.
 * When richer context-tracker data lands on ctx this handler should swap
 * in the analytic version.
 */

import type { Command, SlashCommandContext, SlashCommandResult } from '../types.js';
import type { ContentBlock, Message } from '../../types/provider.js';

function blockSize(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return block.text.length;
    case 'thinking':
      return block.thinking.length;
    case 'tool_use':
      return JSON.stringify(block.input).length + block.name.length;
    case 'tool_result':
      return typeof block.content === 'string'
        ? block.content.length
        : block.content.reduce((n, b) => n + blockSize(b), 0);
    default:
      return 0;
  }
}

function approxChars(messages: readonly Message[]): number {
  let n = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') n += m.content.length;
    else for (const b of m.content) n += blockSize(b);
  }
  return n;
}

const context: Command = {
  type: 'local',
  name: 'context',
  description: 'Summarize the session model, message count, and estimated context size',
  source: 'builtin',
  async call(_args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> {
    const chars = approxChars(ctx.messages);
    // Rough heuristic — without a tokenizer we surface chars and
    // a 4-chars-per-token estimate.
    const approxTokens = Math.round(chars / 4);

    let md = `## Context Usage\n\n`;
    md += `**Model:** ${ctx.model}  \n`;
    md += `**Messages:** ${ctx.messages.length}  \n`;
    md += `**Approx. characters:** ${chars.toLocaleString()}  \n`;
    md += `**Approx. tokens:** ${approxTokens.toLocaleString()} _(rough estimate, 4 chars/token)_\n`;
    md += `\n_Exact token usage is unavailable in this view._\n`;
    return { kind: 'system', markdown: md };
  },
};

export default context;
