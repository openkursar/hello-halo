import type { RouteModuleMeta } from './_meta-types'

export const MODULE: RouteModuleMeta = {
  file: 'artifact',
  routes: {
    'GET /api/spaces/:spaceId/artifacts': {
      expose: 'ai',
      group: 'workspace',
      summary: 'List files and folders in a space',
      returns: '{"success":true,"data":[{"id":"…","name":"report.md","type":"file","path":"/…","relativePath":"report.md","extension":"md","size":1024}]}',
      notes: 'Optional query param maxDepth (default 2) controls how many directory levels deep to list.',
    },

    'GET /api/spaces/:spaceId/artifacts/query': {
      expose: 'ai',
      group: 'workspace',
      summary: 'Search file and folder paths in a space by name',
      query: '?q=report&limit=50',
      returns: '{"success":true,"data":{"items":[{"name":"report.md","type":"file","path":"/…","relativePath":"docs/report.md"}],"truncated":false,"indexing":false}}',
      notes: 'Returns only the best matches (limit defaults to 50). indexing:true means the space is still being indexed and a repeated query may find more; truncated:true means the space has more paths than the index holds.',
    },

    // Per-client lifetime of a space's watcher and caches; only the renderer calls these.
    'POST /api/spaces/:spaceId/artifacts/retain': { expose: 'internal' },
    'POST /api/spaces/:spaceId/artifacts/release': { expose: 'internal' },
    // Decides which `path:line` mentions in a reply render as links; the agent has its own file tools.
    'POST /api/spaces/:spaceId/artifacts/resolve': { expose: 'internal' },

    'GET /api/spaces/:spaceId/artifacts/tree': {
      expose: 'ai',
      group: 'workspace',
      summary: 'Get the full lazy-loadable file tree for a space',
      returns: '{"success":true,"data":{"workspaceRoot":"/…","nodes":[{"id":"…","name":"src","type":"folder","childrenLoaded":false}]}}',
      notes: 'Folder nodes may have childrenLoaded:false — call POST /api/spaces/:spaceId/artifacts/children to load their contents.',
    },

    'POST /api/spaces/:spaceId/artifacts/children': {
      expose: 'ai',
      group: 'workspace',
      summary: "Load one folder's children in the file tree",
      body: '{"dirPath":"/absolute/path/inside/the/space"}',
      returns: '{"success":true,"data":[{"id":"…","name":"index.ts","type":"file"}]}',
      notes: '400 if dirPath is missing. 403 if dirPath resolves outside this space\'s working directory.',
    },

    // Both stream raw bytes past res.json, the only write the loopback
    // listener's redaction wraps, so the generator refuses to label them 'ai'.
    // That gate is about the envelope, not the contents: redaction matches on
    // key names and never looks inside a file, so the exposed artifacts/content
    // hands back a .env verbatim too — its own note says so, because nothing in
    // the transport can.
    'GET /api/artifacts/download': { expose: 'internal' },
    // Download links for the remote page and the phone carry a two-minute ticket
    // for one file instead of the access token; only the renderer asks for one.
    'POST /api/artifacts/download-ticket': { expose: 'internal' },
    'GET /api/artifacts/file/:ticket': { expose: 'internal' },
    'GET /api/spaces/:spaceId/artifacts/download-all': { expose: 'internal' },
    // A remote client's own file, streamed as the request body; only the composer uses it.
    'POST /api/spaces/:spaceId/artifacts/upload': { expose: 'internal' },

    'GET /api/artifacts/content': {
      expose: 'ai',
      group: 'workspace',
      summary: 'Read one file from a space',
      query: '?path=/absolute/path/inside/the/space',
      returns: '{"success":true,"data":{"content":"…","mimeType":"text/plain","encoding":"utf-8","size":1234}}',
      notes: [
        'Binary types (png, jpg, pdf, zip, …) come back base64 with encoding:"base64".',
        'Your own Read tool is usually the better door — this one exists for reading a file in a space that is not your working directory.',
        'The content is verbatim and unredacted, so a .env or a pasted key comes back in the clear. Do not echo it into the conversation.',
        '400 missing path, 403 outside an allowed space, 404 not found, 500 "File too large" above 10MB text / 50MB binary.',
      ].join('\n'),
    },

    'POST /api/artifacts/save': {
      expose: 'ai',
      group: 'workspace',
      summary: "Overwrite a file's content",
      body: '{"path":"/absolute/path/inside/the/space","content":"new file contents"}',
      returns: '{"success":true}',
      impact: 'reversible',
      notes: 'Fully replaces the file in place — no version history or trash, but you can always overwrite it again to correct a mistake. 403 if path resolves outside an allowed space.',
    },

    'GET /api/artifacts/detect-type': {
      expose: 'ai',
      group: 'workspace',
      summary: 'Detect whether a file is text or binary and how it would be viewed',
      returns: '{"success":true,"data":{"isText":true,"canViewInCanvas":true,"contentType":"markdown","mimeType":"text/markdown"}}',
    },

    'POST /api/spaces/:spaceId/artifacts/file': {
      expose: 'ai',
      group: 'workspace',
      summary: 'Create a new file in a space',
      body: '{"parentPath":"","name":"notes.md","content":"# Notes"}',
      returns: '{"success":true,"data":{"path":"/…/notes.md"}}',
      impact: 'reversible',
      notes: '400 if name is missing. parentPath and content are optional — an empty parentPath creates the file at the space root, content defaults to empty. If a file already exists at that path, it is silently overwritten.',
    },

    'POST /api/spaces/:spaceId/artifacts/folder': {
      expose: 'ai',
      group: 'workspace',
      summary: 'Create a new folder in a space',
      body: '{"parentPath":"","name":"assets"}',
      returns: '{"success":true,"data":{"path":"/…/assets"}}',
      notes: '400 if name is missing. parentPath is optional — omit it to create at the space root.',
    },

    'POST /api/spaces/:spaceId/artifacts/reconcile': {
      expose: 'ai',
      group: 'workspace',
      summary: 'Resync the file list with what is actually on disk',
      returns: '{"success":true}',
      notes: 'Use after files changed on disk outside of Halo (e.g. via a terminal command) and the file list looks stale.',
    },

    'DELETE /api/spaces/:spaceId/artifacts': {
      expose: 'ai',
      group: 'workspace',
      summary: 'Move a file or folder to the trash',
      body: '{"path":"/absolute/path/inside/the/space"}',
      returns: '{"success":true}',
      impact: 'reversible',
      notes: '400 if path is missing. Goes to the OS trash (recoverable there), not deleted outright.',
    },

    'POST /api/spaces/:spaceId/artifacts/rename': {
      expose: 'ai',
      group: 'workspace',
      summary: 'Rename a file or folder',
      body: '{"oldPath":"/absolute/path/old-name.md","newName":"new-name.md"}',
      returns: '{"success":true}',
      impact: 'reversible',
      notes: '400 if oldPath or newName is missing. Fails if a file already exists at the new name.',
    },

    'POST /api/spaces/:spaceId/artifacts/move': {
      expose: 'ai',
      group: 'workspace',
      summary: 'Move a file or folder to a different directory',
      body: '{"oldPath":"/absolute/path/inside/the/space/file.md"}',
      returns: '{"success":true,"data":{"path":"/…/new-location/file.md"}}',
      impact: 'reversible',
      notes: '400 if oldPath is missing. newParentPath is optional — omit it to move to the space root.',
    },
  },
}
