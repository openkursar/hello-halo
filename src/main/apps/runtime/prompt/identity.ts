/**
 * apps/runtime/prompt -- Identity Layer Builder
 *
 * The "who am I" layer of the App chat system prompt:
 *   - Base Agent prompt (identity, tools, coding guidelines, env)
 *   - App-specific instructions (from spec — the digital human's "soul")
 *   - Memory access instructions
 *   - User configuration values
 *
 * Channel-agnostic. Does not know about IM, native UI, or any entry
 * point. Outputs an ordered list of ready-to-join fragments.
 */

import type { AppSpec } from '../../spec'
import { buildSystemPrompt, buildSystemPromptWithAIBrowser } from '../../../services/agent/system-prompt'
import { AI_BROWSER_SYSTEM_PROMPT } from '../../../services/ai-browser'
import { AI_TERMINAL_SYSTEM_PROMPT } from '../../../services/ai-terminal'

export interface IdentityFragmentsInput {
  appSpec: AppSpec
  memoryInstructions: string
  userConfig?: Record<string, unknown>
  usesAIBrowser?: boolean
  usesTerminal?: boolean
  workDir: string
  modelInfo?: string
}

export function buildIdentityFragments(input: IdentityFragmentsInput): string[] {
  const fragments: string[] = []

  const promptCtx = {
    workDir: input.workDir,
    modelInfo: input.modelInfo,
    aiBrowserEnabled: input.usesAIBrowser,
  }
  let base = input.usesAIBrowser
    ? buildSystemPromptWithAIBrowser(promptCtx, AI_BROWSER_SYSTEM_PROMPT)
    : buildSystemPrompt(promptCtx)
  if (input.usesTerminal) {
    base += '\n\n' + AI_TERMINAL_SYSTEM_PROMPT.trim()
  }
  fragments.push(base)

  // App "soul" — the spec's system_prompt defines what this digital human does.
  if (input.appSpec.type === 'automation' && input.appSpec.system_prompt) {
    fragments.push(`## App Instructions\n\n${input.appSpec.system_prompt}`)
  }

  if (input.memoryInstructions) {
    fragments.push(input.memoryInstructions)
  }

  if (input.userConfig && Object.keys(input.userConfig).length > 0) {
    fragments.push(
      `## User Configuration\n\n` +
      `The user has configured the following settings for this App:\n\n` +
      `\`\`\`json\n${JSON.stringify(input.userConfig, null, 2)}\n\`\`\``
    )
  }

  return fragments
}
