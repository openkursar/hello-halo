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

    // All three of these hand back arbitrary workspace file bytes with no
    // content-level filtering (readArtifactContent treats .env as first-class
    // viewable text) — download/download-all stream raw bytes outside the
    // JSON envelope entirely, and content wraps the same risk in JSON. A
    // user's pasted API key or saved .env is retrievable byte-for-byte
    // through any of the three, so all three are withheld rather than relying
    // on the redaction layer to reach into free-form file content.
    'GET /api/artifacts/download': { expose: 'internal' },
    'GET /api/spaces/:spaceId/artifacts/download-all': { expose: 'internal' },
    'GET /api/artifacts/content': { expose: 'internal' },

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
