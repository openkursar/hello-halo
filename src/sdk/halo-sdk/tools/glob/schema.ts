/**
 * @module tools/glob/schema
 * Glob tool description and input schema.
 * @license MIT
 */

export const name = 'Glob';

export const description =
  `Locate files by matching their paths against a glob expression. The pattern is relative to path, or to the session's working directory when path is absent; for example, "packages/**/index.ts".

The result lists at most 250 files, newest modification first. Restrict the directory or pattern when the result is incomplete. Matching includes hidden names, but dependency, build, cache, and version-control directories are excluded. The directory walk does not follow symbolic links. Use Grep when the clue is inside a file rather than in its name.`;

export const inputSchema = {
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description: 'Glob pattern relative to the search directory. Supports *, **, ?, character classes, braces (e.g. **/*.{ts,tsx}), and extglobs. Both / and \\ separators are accepted; use character classes such as [*] for literal glob characters.',
    },
    path: {
      type: 'string',
      description: 'Search root directory. Omit to use the session working directory; otherwise provide an existing directory path.',
    },
  },
  required: ['pattern'],
} as const;
