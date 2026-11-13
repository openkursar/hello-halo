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
 * - Native guidance belongs to the engine; Halo contributes one product context.
 */

import { getConfig } from '../../foundation/config.service'

export interface UserAgentSettings {
  /** Tool-call turns per message; undefined falls back to `DEFAULT_MAX_TURNS`. */
  maxTurns?: number
  /** Undefined means never configured: the built-in default list applies. */
  disabledTools?: string[]
  /** Whether Halo can manage digital humans (halo-apps tools and the prompt line about them). */
  digitalHumansEnabled: boolean
  collaborationEnabled: boolean
}

/** What an internal task runs with: the user's settings say nothing about work they never asked for. */
export const INTERNAL_TASK_SETTINGS: UserAgentSettings = {
  digitalHumansEnabled: false,
  collaborationEnabled: false,
}

export function isDigitalHumansEnabled(): boolean {
  return getConfig().agent?.enableDigitalHumans !== false
}

/** Reads only explicit user choices, before native-tool deny rules are appended. */
export function isCollaborationEnabled(disabledTools?: readonly string[]): boolean {
  const withheld = (names?: readonly string[]) => names?.some(name =>
    name === 'Agent' || name === 'Task' || name === 'spawn_agent' || name === 'mcp__halo-team__spawn_agent') === true
  return !withheld(getConfig().agent?.disabledTools) && !withheld(disabledTools)
}

export function readUserAgentSettings(): UserAgentSettings {
  const agent = getConfig().agent
  return {
    maxTurns: agent?.maxTurns,
    disabledTools: agent?.disabledTools,
    digitalHumansEnabled: agent?.enableDigitalHumans !== false,
    collaborationEnabled: isCollaborationEnabled(),
  }
}
