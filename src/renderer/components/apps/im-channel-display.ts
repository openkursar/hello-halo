/** How an IM channel is named and colored in a digital human's contact lists. */

const IM_CHANNEL_DISPLAY: Record<string, { label: string; color: string }> = {
  'wecom-bot': { label: 'WeCom', color: 'text-green-500' },
  'feishu-bot': { label: 'Feishu', color: 'text-blue-500' },
  'dingtalk-bot': { label: 'DingTalk', color: 'text-indigo-500' },
  'weixin-ilink-bot': { label: 'WeChat iLink', color: 'text-green-600' },
}

export function getImChannelDisplay(channel: string) {
  return IM_CHANNEL_DISPLAY[channel] ?? { label: channel, color: 'text-muted-foreground' }
}
