import type { RouteModuleMeta } from './_meta-types'

export const MODULE: RouteModuleMeta = {
  file: 'notify',
  routes: {
    'POST /api/notify-channels/test': {
      expose: 'ai',
      group: 'channels',
      summary: 'Send a test notification through one configured channel',
      body: '{"channelType":"wecom"}',
      returns: '{"success":true,"data":{...delivery result}}',
      impact: 'reversible',
      notes: [
        'channelType is one of: wecom, dingtalk, feishu, email, webhook.',
        'This really delivers a message, so say so before using it.',
        'It is not a way to send something the user dictated: the payload is a fixed test string and nothing you write can go into it. Use the notify_channel tool to send real content.',
        '"No notification channels configured" = the user has not set one up yet.',
      ].join('\n'),
    },

    'POST /api/notify-channels/clear-cache': {
      expose: 'ai',
      group: 'channels',
      summary: 'Drop cached notification-channel access tokens',
      returns: '{"success":true}  // no data',
      impact: 'reversible',
      notes: 'Worth trying when a channel that used to work starts failing to authenticate — the next send fetches a fresh token. It changes no configuration.',
    },

    'GET /api/notify-channels/product-config': {
      expose: 'ai',
      group: 'channels',
      summary: 'Read the product-level notification channel customisation',
      returns: '{"success":true,"data":{"wecom":{"docs":{...}},"email":{"docs":{...}}}}',
      notes: 'Presentation only — help links this build shows per channel. data is null when the build customises nothing. It does not say which channels the user configured.',
    },
  },
}
