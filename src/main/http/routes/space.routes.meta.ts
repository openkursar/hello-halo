import type { RouteModuleMeta } from './_meta-types'

/**
 * Two groups out of one file: spaces themselves belong to `workspace`, the
 * conversations nested under them belong to `conversation`. Where a route
 * lives on disk and where someone looks for it are different questions.
 */
export const MODULE: RouteModuleMeta = {
  file: 'space',
  routes: {
    // Scratch space backing the UI's temporary-session affordance.
    'GET /api/spaces/halo': { expose: 'internal' },

    'GET /api/spaces/default-path': {
      expose: 'ai',
      group: 'workspace',
      summary: 'Read the directory new spaces are created under',
      returns: '{"success":true,"data":"/Users/me/HaloSpaces"}',
    },

    'GET /api/spaces': {
      expose: 'ai',
      group: 'workspace',
      summary: 'List all spaces',
      returns: '{"success":true,"data":[{"id":"<uuid>","name":"Work","path":"/…"}]}',
      notes: 'Start here when you need a spaceId. $HALO_SPACE_ID is the space this conversation is in.',
    },

    'POST /api/spaces': {
      expose: 'ai',
      group: 'workspace',
      summary: 'Create a space',
      body: '{"name":"Product research","icon":"📚"}',
      returns: '{"success":true,"data":{"id":"<uuid>","name":"Product research","path":"/…"}}',
      notes: 'customPath is optional; omit it to create under the default directory.',
    },

    'PUT /api/spaces/reorder': {
      expose: 'ai',
      group: 'workspace',
      summary: 'Set the display order of spaces',
      body: '{"spaceIds":["<uuid>","<uuid>","<uuid>"]}',
      returns: '{"success":true}',
      impact: 'reversible',
      notes: 'Send every space id in the order you want. A partial list scrambles the rest — call GET /api/spaces first and reorder that full list.',
    },

    'GET /api/spaces/:spaceId': {
      expose: 'ai',
      group: 'workspace',
      summary: 'Read one space',
      returns: '{"success":true,"data":{"id":"<uuid>","name":"Work","path":"/…"}}',
    },

    'PUT /api/spaces/:spaceId': {
      expose: 'ai',
      group: 'workspace',
      summary: 'Rename a space or change its icon',
      body: '{"name":"Renamed space"}',
      returns: '{"success":true,"data":{...updated space}}',
      impact: 'reversible',
    },

    'DELETE /api/spaces/:spaceId': {
      expose: 'ai',
      group: 'workspace',
      summary: 'Delete a space and everything inside it',
      returns: '{"success":true}',
      impact: 'irreversible',
      notes: [
        'Deletes the space folder recursively, every conversation in it, and every digital human installed in it.',
        'Nothing is moved to a trash folder and there is no undo.',
        'Name what will be lost and get the user to agree before running this.',
      ].join('\n'),
    },

    'POST /api/spaces/:spaceId/open': {
      expose: 'ai',
      group: 'workspace',
      summary: 'Get a space working directory path',
      returns: '{"success":true,"data":{"path":"/Users/me/HaloSpaces/work"}}',
      notes: 'Returns the path only. It opens nothing — use this to find where a space keeps its files.',
    },

    'GET /api/spaces/:spaceId/conversations': {
      expose: 'ai',
      group: 'conversation',
      summary: 'List conversations in a space',
      returns: '{"success":true,"data":[{"id":"<uuid>","title":"…","starred":false}]}',
    },

    'POST /api/spaces/:spaceId/conversations': {
      expose: 'ai',
      group: 'conversation',
      summary: 'Create an empty conversation',
      body: '{"title":"Weekly report"}',
      returns: '{"success":true,"data":{"id":"<uuid>","title":"Weekly report"}}',
      notes: 'Creates an empty conversation. Making Halo reply in one is not opened to the assistant — the user drives it from the app.',
    },

    'GET /api/spaces/:spaceId/conversations/:conversationId': {
      expose: 'ai',
      group: 'conversation',
      summary: 'Read a conversation with its messages',
      returns: '{"success":true,"data":{"id":"<uuid>","messages":[{"role":"user","content":"…"}]}}',
      notes: 'Long conversations return a lot of text. Read one only when you need its content.',
    },

    'PUT /api/spaces/:spaceId/conversations/:conversationId': {
      expose: 'ai',
      group: 'conversation',
      summary: 'Update a conversation title or metadata',
      body: '{"title":"Renamed conversation"}',
      returns: '{"success":true,"data":{...updated conversation}}',
      impact: 'reversible',
    },

    'DELETE /api/spaces/:spaceId/conversations/:conversationId': {
      expose: 'ai',
      group: 'conversation',
      summary: 'Delete a conversation',
      returns: '{"success":true}',
      impact: 'irreversible',
      notes: [
        'Removes the conversation file and its reasoning history from disk with no backup.',
        'Confirm with the user first — there is no undo.',
      ].join('\n'),
    },

    // Renderer plumbing: the UI appends and patches message records as a turn
    // streams. Writing history directly would let fabricated turns look real.
    'POST /api/spaces/:spaceId/conversations/:conversationId/messages': { expose: 'internal' },
    'PUT /api/spaces/:spaceId/conversations/:conversationId/messages/last': { expose: 'internal' },
    'GET /api/spaces/:spaceId/conversations/:conversationId/messages/:messageId/thoughts': {
      expose: 'internal',
    },

    'POST /api/spaces/:spaceId/conversations/:conversationId/star': {
      expose: 'ai',
      group: 'conversation',
      summary: 'Star or unstar a conversation',
      body: '{"starred":true}',
      returns: '{"success":true}',
      impact: 'reversible',
    },
  },
}
