import type { RouteModuleMeta } from './_meta-types'

export const MODULE: RouteModuleMeta = {
  file: 'im',
  routes: {
    'GET /api/wecom-bot/status': {
      expose: 'ai',
      group: 'channels',
      summary: 'Check whether a WeCom bot channel is configured and connected',
      returns: '{success:true,data:{configured:boolean,enabled:boolean,connected:boolean}}',
      notes: 'Legacy single-bot view (booleans only, no token). For per-instance detail use GET /api/im-channels/status.',
    },
    'POST /api/wecom-bot/reconnect': {
      expose: 'ai',
      group: 'channels',
      summary: 'Reconnect all configured WeCom bot instances',
      returns: '{success:true}',
      impact: 'reversible',
      notes: 'A brief connection interruption while it reconnects — no data lost.',
    },
        // The whole QR pairing flow stays closed: its final step hands back a
    // long-lived secret, so an agent could start a scan it can never finish and
    // leave the user holding a half-paired bot. GROUPS.channels.withheld says
    // where to do it instead.
    'POST /api/wecom-bot/scan-auth/start': { expose: 'internal' },
    // This endpoint's whole purpose is handing back the paired bot's
    // long-lived credential (botId+secret) — internal regardless of the
    // transport-layer redaction the self-API adds elsewhere.
    'POST /api/wecom-bot/scan-auth/poll': {
      expose: 'internal',
    },
    
    'POST /api/wecom-bot/scan-auth/cancel': { expose: 'internal' },
    
    'POST /api/wecom-bot/scan-auth/create-assistant': { expose: 'internal' },
    'GET /api/im-channels/status': {
      expose: 'ai',
      group: 'channels',
      summary: 'Get connection status for all IM channel instances, or one via ?instanceId=',
      returns: '{success:true,data:{id,type,enabled,connected,state?,appId,appName?,reason?,identityResolution?}[] | <single instance object>}',
      notes: 'No credentials in this response. instanceId not found → {success:false,error}.',
    },
    'POST /api/im-channels/reconnect': {
      expose: 'ai',
      group: 'channels',
      summary: 'Reconnect one IM channel instance',
      body: '{"instanceId":"<instanceId — from GET /api/im-channels/status>"}',
      returns: '{success:boolean,error?}',
      impact: 'reversible',
      notes: '400 if instanceId is missing. success:false with an error message if the instanceId is unknown.',
    },
    'POST /api/im-channels/reload': {
      expose: 'ai',
      group: 'channels',
      summary: 'Reload all IM channel instances from saved config',
      returns: '{success:true}',
      impact: 'reversible',
      notes: 'Use after a config change made through another route to apply it without restarting Halo. Stops and rebuilds any instance whose config changed — brief interruption, no data lost.',
    },
    'GET /api/im-channels/providers': {
      expose: 'ai',
      group: 'channels',
      summary: 'List available IM channel provider types and their config fields',
      returns: '{success:true,data:[{type,displayName,description,direction,configFields:[{key,label,type,placeholder?,required?}],defaultConfig}]}',
      notes: 'Schema only. No endpoint here creates an instance from it — the user creates instances in Settings > Message Channels. Schema only (field definitions and empty defaults) — no configured instance data or secrets.',
    },
    'GET /api/im-channels/permission-defaults': {
      expose: 'ai',
      group: 'channels',
      summary: 'Get this build\'s default guest-access permission settings for new IM instances',
      returns: '{success:true,data:{defaultEnabled?,defaultGuestAccess?,defaultGuestPolicy?:{allowedTools?},ownerIdHint?,ownerSetupGuideUrl?} | null}',
    },
    
    'POST /api/weixin-ilink/request-qrcode': { expose: 'internal' },
    // This endpoint's whole purpose is handing back the paired account's bot
    // token — internal regardless of the transport-layer redaction the
    // self-API adds elsewhere.
    'POST /api/weixin-ilink/poll-auth-status': {
      expose: 'internal',
    },
    'POST /api/weixin-ilink/save-token': {
      expose: 'ai',
      group: 'channels',
      summary: 'Set the bot token for an already-configured WeChat iLink instance',
      body: '{"instanceId":"<instanceId — from GET /api/im-channels/status>","botToken":"..."}',
      returns: '{success:true} or {success:false,error}',
      impact: 'reversible',
      notes: [
        'Optional fields: baseUrl, accountId.',
        'instanceId must already exist (created earlier in the Settings UI) — this route cannot create a new instance, only fill in its token.',
        'Never echoes the token back in the response.',
        '{success:false,error:"..."} when instanceId is not found in config.',
        'Takes over that channel identity immediately — a wrong token silently hijacks it until corrected.',
      ].join('\n'),
    },
    'POST /api/weixin-ilink/disconnect': {
      expose: 'ai',
      group: 'channels',
      summary: 'Clear WeChat iLink credentials for an instance and stop it',
      body: '{"instanceId":"<instanceId — from GET /api/im-channels/status>"}',
      returns: '{success:true} or {success:false,error}',
      impact: 'reversible',
      notes: 'Can be restored by pairing again (request-qrcode) or by calling save-token with the same token.',
    },
    'GET /api/im-sessions': {
      expose: 'ai',
      group: 'channels',
      summary: 'List known IM contacts/chats bound to digital humans, optional ?appId= filter',
      returns: '{success:true,data:[{appId,channel,chatId,proactive,customName?,...}]}',
    },
    'POST /api/im-sessions/set-proactive': {
      expose: 'ai',
      group: 'channels',
      summary: "Toggle whether a run's result is auto-pushed to this chat when it finishes",
      body: '{"appId":"<appId — a uuid from GET /api/apps>","channel":"wecom-bot","chatId":"<chatId — from GET /api/im-sessions>","proactive":true}',
      returns: '{success:true} or {success:false,error}',
      impact: 'reversible',
      notes: '404 if no matching session exists yet — the chat must have messaged the digital human at least once.',
    },
    'POST /api/im-sessions/remove': {
      expose: 'ai',
      group: 'channels',
      summary: 'Remove a chat binding from the IM session registry',
      body: '{"appId":"<appId — a uuid from GET /api/apps>","channel":"wecom-bot","chatId":"<chatId — from GET /api/im-sessions>"}',
      returns: '{success:true,data:{removed:boolean}}',
      impact: 'reversible',
      notes: 'removed:false means no matching session was found — not an error. Only removes display metadata (custom name, proactive flag); the chat re-registers itself on its next inbound message, message history is not stored here.',
    },
    'POST /api/im-sessions/set-custom-name': {
      expose: 'ai',
      group: 'channels',
      summary: 'Set a custom display name for a chat binding',
      body: '{"appId":"<appId — a uuid from GET /api/apps>","channel":"wecom-bot","chatId":"<chatId — from GET /api/im-sessions>","name":"Sales Team Chat"}',
      returns: '{success:true} or {success:false,error}',
      impact: 'reversible',
      notes: '404 if no matching session exists yet.',
    },
  },
}
