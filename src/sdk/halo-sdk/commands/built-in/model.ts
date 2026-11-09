/**
 * /model — show or set the active model:
 *
 *   - no args  → report the currently active model
 *   - one arg  → switch the session to that model and confirm
 *
 * The SDK does not validate the model identifier here; provider adapters
 * surface "unknown model" errors on the next turn. Interactive model pickers
 * belong in the host application — with no args this emits a hint rather
 * than a UI directive.
 */

import type { Command, SlashCommandContext, SlashCommandResult } from '../types.js';

const model: Command = {
  type: 'local',
  name: 'model',
  description: 'Set the AI model',
  argumentHint: '[model]',
  source: 'builtin',
  async call(args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> {
    const target = args.trim();
    if (!target) {
      return {
        kind: 'system',
        markdown: `**Current model:** \`${ctx.model}\`\n\nPass a model id to switch — e.g. \`/model deepseek-chat\`.`,
      };
    }
    const previous = ctx.model;
    ctx.setModel(target);
    return {
      kind: 'system',
      markdown: `Model switched: \`${previous}\` → \`${target}\``,
    };
  },
};

export default model;
