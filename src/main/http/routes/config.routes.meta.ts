import type { RouteModuleMeta } from './_meta-types'

export const MODULE: RouteModuleMeta = {
  file: 'config',
  routes: {
    'GET /api/security/policy': {
      expose: 'ai',
      group: 'settings',
      summary: 'Read the security policy this build runs under',
      returns: '{"success":true,"data":{"tunnelSafe":boolean,"browserAllowlistEditable":boolean}}',
      notes: 'Tells you which of two guarded behaviours this build permits before you attempt one. Cannot fail.',
    },

    'GET /api/config': {
      expose: 'ai',
      group: 'settings',
      summary: 'Read the global configuration',
      returns: '{"success":true,"data":{...}}  // secret fields come back as "***"',
      notes: 'Read-only here. The write side is not opened to the assistant.',
    },

    'GET /api/config/credential-failures': {
      expose: 'ai',
      group: 'settings',
      summary: 'List credential fields that failed to decrypt at rest',
      returns: '{"success":true,"data":[{"path":"...","label":"..."}]}',
      notes: 'Path and label only, never ciphertext. Non-empty means the user must re-enter that credential in the Halo app.',
    },

    // Not atomic: `saveConfig` shallow-merges the top level and deep-merges
    // only a fixed list of branches, which notificationChannels and imChannels
    // are not on — so sending one of those replaces it wholesale. The renderer
    // survives by always resending the full array, an unwritten convention no
    // type or check enforces, and a partial write drops the user's other
    // settings silently, with success:true. Masked secrets are not the
    // obstacle: '***' sentinels round-trip through `unmaskSentinels` untouched.
    'POST /api/config': { expose: 'internal' },

    // Both take a plaintext apiKey in the request body, so using them would
    // mean asking the user to paste a key into the conversation.
    'POST /api/config/validate': { expose: 'internal' },
    'POST /api/config/fetch-models': { expose: 'internal' },

    'POST /api/config/refresh-ai-sources': {
      expose: 'ai',
      group: 'settings',
      summary: 'Re-read every model source and return the refreshed config',
      returns: '{"success":true,"data":{...}}  // same masked shape as GET /api/config',
      notes: 'Use it when GET /api/config looks stale after the user changed a source in the app. It re-reads what is stored; it cannot add or fix a credential.',
    },
  },
}
