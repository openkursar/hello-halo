import type { RouteModuleMeta } from './_meta-types'

export const MODULE: RouteModuleMeta = {
  file: 'ai-sources',
  routes: {
    'POST /api/ai-sources/switch-source': {
      expose: 'ai',
      group: 'settings',
      summary: 'Switch to a different configured model source',
      body: '{"sourceId":"<sourceId — a uuid from GET /api/config>"}',
      returns: '{"success":true,"data":{"currentId":"<uuid>","currentModel":"..."}}',
      impact: 'reversible',
      notes: [
        'Picks among sources the user already configured. It cannot create one or change a key.',
        'Applies to what Halo runs next, including this assistant. Switch back the same way.',
        '"Source not found" = wrong sourceId; read the configured list from GET /api/config first.',
      ].join('\n'),
    },

    'POST /api/ai-sources/set-model': {
      expose: 'ai',
      group: 'settings',
      summary: 'Switch the model within the current source',
      body: '{"modelId":"deepseek-chat"}',
      returns: '{"success":true,"data":{"currentId":"<uuid>","currentModel":"deepseek-chat"}}',
      impact: 'reversible',
      notes: 'Applies to what Halo runs next, including this assistant. Switch back the same way.',
    },

    // Creating or editing a source is the credential surface itself.
    'POST /api/ai-sources/sources': { expose: 'internal' },
    'PUT /api/ai-sources/sources/:sourceId': { expose: 'internal' },
    'DELETE /api/ai-sources/sources/:sourceId': { expose: 'internal' },

    'POST /api/model-capabilities/resolve': { expose: 'internal' },
    'GET /api/model-capabilities/preset/:modelId': { expose: 'internal' },

    'GET /api/model-capabilities/all': {
      expose: 'ai',
      group: 'settings',
      summary: 'List what every known model supports (vision, tools, context)',
      returns: '{"success":true,"data":{"<modelId>":{...capability flags}}}',
      notes: 'Read-only presets. It does not say which model is currently in use.',
    },
  },
}
