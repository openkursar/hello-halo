/**
 * Agent Module - User AI Settings
 *
 * The one place the user's global AI settings (Settings > Advanced) are read
 * for an agent session. Entry points never pass these on: passing them is what
 * let a session forget one, so the layers that assemble a session
 * (`sdk-config.ts`, `system-prompt.ts`, `toolsets/base.ts`) call this instead.
 *
 * Where a setting is NOT read here:
 * - `configDirMode` / `customConfigDir` decide `CLAUDE_CONFIG_DIR`, which every
 *   subprocess needs (it holds the CLI credential slot as well as skills and
 *   CLAUDE.md), internal tasks included. `buildSdkEnv` resolves it itself via
 *   `resolveClaudeConfigDir`.
 * - Engine differences stay where the engine differs: `promptProfile` only
 *   picks a template on engines that take Halo's prompt (`buildSystemPrompt`);
 *   `maxTurns` and `disabledTools` mean the same on every engine.
 */

import { getConfig } from '../../foundation/config.service'
import type { PromptProfile } from './system-prompt'

export interface UserAgentSettings {
  /** Tool-call turns per message; undefined falls back to `DEFAULT_MAX_TURNS`. */
  maxTurns?: number
  /** Undefined means the default profile. */
  promptProfile?: PromptProfile
  /** Undefined means never configured: the built-in default list applies. */
  disabledTools?: string[]
  /** Whether Halo can manage digital humans (halo-apps tools and the prompt line about them). */
  digitalHumansEnabled: boolean
}

/** What an internal task runs with: the user's settings say nothing about work they never asked for. */
export const INTERNAL_TASK_SETTINGS: UserAgentSettings = {
  promptProfile: 'halo',
  digitalHumansEnabled: false,
}

export function isDigitalHumansEnabled(): boolean {
  return getConfig().agent?.enableDigitalHumans !== false
}

export function readUserAgentSettings(): UserAgentSettings {
  const agent = getConfig().agent
  return {
    maxTurns: agent?.maxTurns,
    promptProfile: agent?.promptProfile,
    disabledTools: agent?.disabledTools,
    digitalHumansEnabled: agent?.enableDigitalHumans !== false,
  }
}
