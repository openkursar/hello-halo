/**
 * @module tools/write/schema
 * File Write tool description and input schema.
 * @license MIT
 */

export const name = 'Write';

export const description =
  `Save content as the complete text of a local file. A new path creates a file; an existing path loses its previous contents after a successful write.

Read an existing target in full first and preserve anything the task does not ask to replace. A partial or truncated view does not authorize whole-file replacement; use Edit for a targeted change when a complete Read is unavailable. If the file changes after that read, inspect the new version before trying again. Use Edit for a small change so unrelated contents need not be resubmitted. Create only files needed for the user's requested outcome.`;

export const inputSchema = {
  type: 'object',
  properties: {
    file_path: {
      type: 'string',
      description: 'Absolute filesystem destination for the new file or complete replacement.',
    },
    content: {
      type: 'string',
      description: 'The content to write to the file',
    },
  },
  required: ['file_path', 'content'],
} as const;
