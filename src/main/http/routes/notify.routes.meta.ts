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

    'POST /api/notify-channels/clear-cache': { expose: 'internal' },

    // Product-level customisation read out of product.json.
    'GET /api/notify-channels/product-config': { expose: 'internal' },
  },
}
