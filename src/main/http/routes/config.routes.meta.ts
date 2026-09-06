import type { RouteModuleMeta } from './_meta-types'

export const MODULE: RouteModuleMeta = {
  file: 'config',
  routes: {
    'GET /api/security/policy': { expose: 'internal' },

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

    // Write side of the credential surface.
    'POST /api/config': { expose: 'internal' },

    // Both take a plaintext apiKey in the request body, so using them would
    // mean asking the user to paste a key into the conversation.
    'POST /api/config/validate': { expose: 'internal' },
    'POST /api/config/fetch-models': { expose: 'internal' },

    // Returns getServiceConfig() directly, bypassing the controller's masking.
    'POST /api/config/refresh-ai-sources': { expose: 'internal' },
  },
}
