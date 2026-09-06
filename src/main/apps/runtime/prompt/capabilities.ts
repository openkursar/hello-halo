/**
 * apps/runtime/prompt -- Disabled Capabilities Guidance
 *
 * A digital human's tool capabilities are governed solely by its per-app
 * permissions (the Capabilities panel — resolvePermission), for BOTH interactive
 * chat and headless automation runs. Unlike space chat, a digital human has no
 * in-chat toolset broker: there is exactly one place to grant a capability.
 *
 * This fragment makes the model aware of which toggleable capabilities the user
 * has turned OFF, and names the single correct place to re-enable them. Without
 * it a disabled capability is silent — the model just lacks the tool and cannot
 * point the user anywhere. It renders only when something is actually disabled,
 * so the default (all capabilities on) adds nothing to the prompt.
 */

import { resolvePermission } from '../../../../shared/apps/app-types'
import { isTerminalAvailable } from '../../../services/ai-terminal'

interface ToggleableCapability {
  /** Permission id passed to resolvePermission. */
  permission: string
  /** Human label matching the Capabilities panel. */
  label: string
  /** What the capability grants, phrased for the model. */
  grants: string
}

/**
 * The user-toggleable built-in capabilities, in Capabilities-panel order.
 * Always-on capabilities (web search, memory, OCR) are intentionally excluded —
 * they can never be "disabled", so guiding the user to enable them is nonsense.
 *
 * 'halo-api-ref' (Operate Halo) is excluded for the opposite reason: it is off
 * unless granted, so it is absent for nearly every app. Listing it would make
 * this fragment render on every run — the always-on prompt cost the automation
 * path exists to avoid — to advertise a capability the user never asked for.
 * The Capabilities panel is where it is discovered.
 */
const TOGGLEABLE_CAPABILITIES: ToggleableCapability[] = [
  { permission: 'ai-browser', label: 'AI Browser', grants: 'browsing the web, filling forms, scraping pages, and browser automation' },
  { permission: 'ai-terminal', label: 'AI Terminal', grants: 'running shell commands, SSH, and interactive terminals' },
  { permission: 'email', label: 'Email', grants: 'reading, sending, and managing emails and calendar' },
  { permission: 'im-push', label: 'IM Push', grants: 'sending messages to IM contacts' },
]

/**
 * Build the "disabled capabilities" system-prompt fragment for a digital human,
 * or null when every toggleable capability is enabled.
 *
 * A capability counts as disabled only when the user explicitly opted out
 * (resolvePermission returns false). AI Terminal is additionally omitted when the
 * platform cannot run terminals at all — enabling the toggle would not help, so
 * telling the user to flip it would be misleading.
 */
export function buildDisabledCapabilitiesGuidance(
  app: Parameters<typeof resolvePermission>[0]
): string | null {
  const disabled = TOGGLEABLE_CAPABILITIES.filter((cap) => {
    if (resolvePermission(app, cap.permission)) return false
    if (cap.permission === 'ai-terminal' && !isTerminalAvailable()) return false
    return true
  })
  if (disabled.length === 0) return null

  const lines = disabled.map((cap) => `- ${cap.label} — ${cap.grants}`)
  return (
    '## Disabled capabilities\n\n' +
    'These built-in capabilities exist but are currently turned OFF for this digital human, ' +
    'so you do not have their tools in this session:\n\n' +
    lines.join('\n') +
    '\n\nYou cannot enable them yourself. If a task requires one, tell the user to turn it on in ' +
    "this digital human's Settings → Capabilities, then retry."
  )
}

/**
 * Runtime facts the "awaiting setup" guidance needs but the app permissions
 * alone cannot tell. Both are external to the per-app toggle: a capability can
 * be switched ON yet still be tool-less until its channel/contact exists.
 */
export interface CapabilitySetupContext {
  /** A usable email notification channel is configured & enabled globally. */
  emailChannelConfigured: boolean
  /** At least one pushable IM contact exists for this digital human. */
  imContactsAvailable: boolean
}

/**
 * Build the "capabilities awaiting setup" fragment, or null when nothing is
 * pending. Covers the gap the disabled-guidance cannot: a capability whose
 * toggle is ON but whose tools are still absent because a required channel or
 * contact has not been configured (Email needs an email channel; IM Push needs
 * a connected IM contact). Without this, the tool is silently missing while the
 * user believes the capability is active — the model then guesses and misleads.
 *
 * Only the two config-dependent capabilities are checked. AI Browser / AI
 * Terminal need no external setup: their toggle being ON already means the tool
 * is loaded, so they can never be in this state.
 */
export function buildUnconfiguredCapabilitiesGuidance(
  app: Parameters<typeof resolvePermission>[0],
  ctx: CapabilitySetupContext
): string | null {
  const pending: string[] = []

  if (resolvePermission(app, 'email') && !ctx.emailChannelConfigured) {
    pending.push(
      '- Email — enabled, but no email channel is configured, so its tools are ' +
      'not loaded. To use it, the user must configure an email channel in ' +
      'Settings → Message Channels.'
    )
  }
  if (resolvePermission(app, 'im-push') && !ctx.imContactsAvailable) {
    pending.push(
      '- IM Push — enabled, but no IM contact is connected, so notify_bot is ' +
      'not available. To use it, the user must connect an IM channel in ' +
      'Settings → Message Channels and add this digital human to a chat.'
    )
  }

  if (pending.length === 0) return null

  return (
    '## Capabilities awaiting setup\n\n' +
    'These capabilities are turned ON for this digital human, but a required ' +
    'channel or contact is not configured yet — so their tools are NOT loaded ' +
    'in this session:\n\n' +
    pending.join('\n') +
    '\n\nDo not claim you can send email or push IM messages right now. If a task ' +
    'needs one, tell the user exactly what to configure, then retry.'
  )
}
