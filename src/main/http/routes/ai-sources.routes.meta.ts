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

    // Creating a source cannot avoid a plaintext apiKey in the body, which
    // would mean asking the user to paste a key into the conversation.
    'POST /api/ai-sources/sources': { expose: 'internal' },

    'PUT /api/ai-sources/sources/:sourceId': {
      expose: 'ai',
      group: 'settings',
      summary: 'Edit a configured model source',
      body: '{"name":"Work account"}',
      returns: '{"success":true,"data":{...the full sources config, secret fields redacted}}',
      impact: 'reversible',
      notes: [
        'Merges field by field, so send only what changes. Leave apiKey out and the stored one is untouched — renaming a source or pointing it at a different model never needs the key.',
        'Do not send apiKey through here. The route would take it, but a key typed into a conversation is a key the user cannot take back; changing one is Settings > AI Model.',
      ].join('\n'),
    },

    'DELETE /api/ai-sources/sources/:sourceId': {
      expose: 'ai',
      group: 'settings',
      summary: 'Delete a configured model source',
      returns: '{"success":true,"data":{...the remaining sources config, secret fields redacted}}',
      impact: 'irreversible',
      narrowerAlternative: 'POST /api/ai-sources/switch-source',
      notes: 'The stored API key goes with it, and no endpoint here can put one back — only the user can, in Settings > AI Model. Confirm before deleting.',
    },

    'POST /api/model-capabilities/resolve': {
      expose: 'ai',
      group: 'settings',
      summary: 'Resolve a model id to its effective capabilities',
      body: '{"modelId":"deepseek-chat"}',
      returns: '{"success":true,"data":{"displayName":"...","provider":"...","contextWindow":128000,"maxOutputTokens":8192,"vision":false,"thinking":false}}',
      notes: 'Applies the user\'s overrides on top of the shipped preset, which is what makes it differ from the preset endpoint. 400 when modelId is missing or not a string.',
    },

    'GET /api/model-capabilities/preset/:modelId': {
      expose: 'ai',
      group: 'settings',
      summary: 'Read the shipped capability preset for one model',
      returns: '{"success":true,"data":{"displayName":"...","provider":"...","contextWindow":128000,"maxOutputTokens":8192,"vision":false,"thinking":false}}',
      notes: [
        'An unknown model returns data:null with success:true — not a 404.',
        'Percent-encode a modelId that contains slashes.',
      ].join('\n'),
    },

    'GET /api/model-capabilities/all': {
      expose: 'ai',
      group: 'settings',
      summary: 'List what every known model supports (vision, tools, context)',
      returns: '{"success":true,"data":{"<modelId>":{...capability flags}}}',
      notes: 'Read-only presets. It does not say which model is currently in use.',
    },
  },
}
