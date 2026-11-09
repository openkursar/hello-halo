/**
 * /init — bootstrap a project instruction file for the current repo.
 *
 * The dispatcher replaces the user's `/init …` input with the
 * user-message produced here and the normal query loop runs.
 */

import type { Command, SlashCommandContext } from '../types.js';
import type { Message } from '../../types/provider.js';
import { DEFAULT_CONVENTIONS } from '../../core/conventions.js';

const init: Command = {
  type: 'prompt',
  name: 'init',
  description: `Inspect this repository and prepare or improve its ${DEFAULT_CONVENTIONS.memoryFiles[0]} working guide`,
  source: 'builtin',
  async getPromptForCommand(_args: string, _ctx: SlashCommandContext): Promise<Message[]> {
    // Target the preferred instruction file name so the scaffolding lands
    // where the loader looks first.
    const fileName = DEFAULT_CONVENTIONS.memoryFiles[0];
    const prompt = `Produce a compact repository handover in ${fileName} for an agent making its next change here.

Begin with the instructions already maintained by the project, including editor and assistant configuration. Read ${fileName} if it exists. Keep valid requirements, resolve claims against the implementation, and identify uncertainty instead of inventing a policy.

Use the README, build or package configuration, and representative entry points as evidence. The guide should answer three practical questions: Where does a change belong and which dependency boundaries must it respect? What project-specific constraints could a newcomer miss? How does the project prepare, build, and verify changes, including a focused test when one is available?

Write concrete commands and paths only after checking them. Explain the reason for an important boundary, but omit a file inventory, generic engineering advice, and material already adequately covered by existing instructions. Improve an existing guide in place; for a new file, use "# ${fileName}" as its heading and explain its purpose briefly. The result should be short enough to consult before beginning a task.`;

    return [{ role: 'user', content: prompt }];
  },
};

export default init;
