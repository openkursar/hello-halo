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
import { getKBReferencesForApp } from '../../../services/tlon'

export interface IdentityFragmentsInput {
  appId: string
  appSpec: AppSpec
  memoryInstructions: string
  userConfig?: Record<string, unknown>
  usesAIBrowser?: boolean
  usesTerminal?: boolean
  workDir: string
  modelInfo?: string
  /**
   * Pre-rendered "disabled capabilities" guidance (buildDisabledCapabilitiesGuidance).
   * Present only when the user has turned a toggleable capability off; the caller
   * owns the computation because it has the full InstalledApp. Undefined = omit.
   */
  disabledCapabilities?: string
  /**
   * Pre-rendered "capabilities awaiting setup" guidance
   * (buildUnconfiguredCapabilitiesGuidance). Present only when a capability is
   * toggled ON but its channel/contact is not configured yet. The caller owns
   * the computation because it depends on runtime state (channel config, IM
   * contacts). Undefined = omit.
   */
  unconfiguredCapabilities?: string
}

export function buildIdentityFragments(input: IdentityFragmentsInput): string[] {
  const fragments: string[] = []

  const promptCtx = {
    workDir: input.workDir,
    modelInfo: input.modelInfo,
    knowledgeBases: getKBReferencesForApp(input.appId),
  }
  let base = input.usesAIBrowser
    ? buildSystemPromptWithAIBrowser(promptCtx, AI_BROWSER_SYSTEM_PROMPT)
    : buildSystemPrompt(promptCtx)
  if (input.usesTerminal) {
    base += '\n\n' + AI_TERMINAL_SYSTEM_PROMPT.trim()
  }
  fragments.push(base)

  // Capability awareness: name the capabilities the user turned off and where to
  // re-enable them. Sits right after the base (tool) layer so the model reads it
  // alongside what it *can* do.
  if (input.disabledCapabilities) {
    fragments.push(input.disabledCapabilities)
  }

  // Capability awareness (setup gap): capabilities toggled ON but tool-less
  // until a channel/contact is configured. Keeps the model from claiming a tool
  // it does not actually have loaded.
  if (input.unconfiguredCapabilities) {
    fragments.push(input.unconfiguredCapabilities)
  }

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
