import type { Command, SlashCommandContext, SlashCommandResult } from '../types.js';

const compact: Command = {
  type: 'local',
  name: 'compact',
  description:
    'Condense earlier messages through the session compaction handler, with optional handover requirements',
  argumentHint: '[instructions]',
  source: 'builtin',
  async call(args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> {
    const instructions = args.trim() || undefined;
    await ctx.compactSession(instructions);
    return {
      kind: 'system',
      markdown: instructions
        ? `Compaction started with instructions: _${instructions}_`
        : 'Compaction started.',
    };
  },
};

export default compact;
