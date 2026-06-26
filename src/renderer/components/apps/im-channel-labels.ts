/**
 * Display labels for IM channel provider types.
 *
 * Single source of truth for the renderer — import this instead of defining
 * a local map in each component.  When a new channel type is added, update
 * only here; all consuming components get the label automatically.
 */
export const CHANNEL_LABELS: Record<string, string> = {
  'wecom-bot': 'WeCom',
  'feishu-bot': 'Feishu',
  'dingtalk-bot': 'DingTalk',
  'http': 'HTTP',
}
