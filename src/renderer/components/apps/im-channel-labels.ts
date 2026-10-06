/**
 * How IM channel provider types are named and colored in the renderer.
 *
 * Single source of truth for the renderer — import this instead of defining
 * a local map in each component.  When a new channel type is added, update
 * only here; all consuming components get the label automatically.
 */

import type { HTTP_SESSION_CHANNEL, ImChannelType } from '../../../shared/types/im-channel'

interface ImChannelDisplay {
  label: string
  color: string
}

// Keyed by the channel union, so a new channel type does not compile until it is named here.
const IM_CHANNEL_DISPLAY: Record<ImChannelType | typeof HTTP_SESSION_CHANNEL, ImChannelDisplay> = {
  'wecom-bot': { label: 'WeCom', color: 'text-green-500' },
  'feishu-bot': { label: 'Feishu', color: 'text-blue-500' },
  'dingtalk-bot': { label: 'DingTalk', color: 'text-indigo-500' },
  'weixin-ilink-bot': { label: 'WeChat iLink', color: 'text-green-600' },
  'http': { label: 'HTTP', color: 'text-muted-foreground' },
}

export const CHANNEL_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(IM_CHANNEL_DISPLAY).map(([type, display]) => [type, display.label]),
)

/** A channel type's name and color; a type not listed here shows as itself. */
export function getImChannelDisplay(channel: string): ImChannelDisplay {
  return (IM_CHANNEL_DISPLAY as Record<string, ImChannelDisplay | undefined>)[channel]
    ?? { label: channel, color: 'text-muted-foreground' }
}
