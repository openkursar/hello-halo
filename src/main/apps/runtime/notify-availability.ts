/**
 * apps/runtime -- Notify Capability Availability
 *
 * Single source of truth for "can this digital human actually fire a
 * notification right now". A capability toggle being ON does not guarantee the
 * tool is loaded: `notify_channel` needs a configured external channel and
 * `notify_bot` needs a connected IM contact. The MCP injection (notify-tool.ts),
 * the automation prompt (prompt.ts), the interactive-chat prompt (app-chat.ts),
 * and the IM entry (im-channels/im-prompt.ts) must all agree on these facts, so
 * they derive them from here instead of re-deriving independently and drifting.
 *
 * The mirrored injection rules live in notify-tool.ts (buildNotifyChannelTool /
 * buildNotifyBotTool); if those conditions ever change, update both.
 */

import { resolvePermission } from '../../../shared/apps/app-types'
import { getEnabledChannels } from '../../services/notify-channels'
import type { NotificationChannelsConfig } from '../../../shared/types/notification-channels'
import type { ImSessionRecord } from '../../../shared/types/im-channel'

export interface NotifyAvailability {
  /** notify_channel is loaded: at least one external channel is enabled. */
  channelsConfigured: boolean
  /** The email channel specifically is configured & enabled (maps to the Email capability). */
  emailChannelConfigured: boolean
  /** At least one pushable IM contact exists for this digital human. */
  imContactsAvailable: boolean
  /** notify_bot is loaded: im-push is granted AND a pushable contact exists. */
  notifyBotAvailable: boolean
  /** Either notify tool is loaded — used to gate notification prompt guidance. */
  anyNotifyToolAvailable: boolean
}

/**
 * Resolve which notification tools are actually available for a run.
 *
 * @param app       The installed app (permissions + spec) — reads the im-push toggle.
 * @param channels  The global notification-channels config (config.notificationChannels).
 * @param imSessions The app's PUSHABLE IM sessions (registry.getPushableSessions).
 *                   Callers already fetch these for the notify MCP server; pass the
 *                   same array so this stays a pure computation with no extra lookups.
 */
export function resolveNotifyAvailability(
  app: Parameters<typeof resolvePermission>[0],
  channels: NotificationChannelsConfig | undefined,
  imSessions: ImSessionRecord[]
): NotifyAvailability {
  const channelsConfigured = getEnabledChannels(channels).length > 0
  const emailChannelConfigured = !!channels?.email?.enabled
  const imContactsAvailable = imSessions.length > 0
  const notifyBotAvailable = resolvePermission(app, 'im-push') && imContactsAvailable

  return {
    channelsConfigured,
    emailChannelConfigured,
    imContactsAvailable,
    notifyBotAvailable,
    anyNotifyToolAvailable: channelsConfigured || notifyBotAvailable,
  }
}
