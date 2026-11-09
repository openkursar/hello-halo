/**
 * /clear — clears conversation history.
 *
 * Invokes the session-supplied `clearMessages` hook and yields a system
 * message confirming the operation. The dispatcher surfaces the markdown
 * body without invoking the LLM.
 */

import type { Command, SlashCommandContext, SlashCommandResult } from '../types.js';

const clear: Command = {
  type: 'local',
  name: 'clear',
  description: 'Start with an empty conversation while keeping the current session settings',
  aliases: ['reset', 'new'],
  source: 'builtin',
  async call(_args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> {
    await ctx.clearMessages();
    return { kind: 'system', markdown: 'Conversation history cleared.' };
  },
};

export default clear;
