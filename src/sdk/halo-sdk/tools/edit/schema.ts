/**
 * @module tools/edit/schema
 * File Edit tool description and input schema.
 * @license MIT
 */

export const name = 'Edit';

export const description =
  `Change an existing text file by substituting new_string for old_string.

Read the target before editing so the change is grounded in its current contents. A stale read can be rejected if another writer changed the file; read again and reconsider the edit in that case. Preserve the source's whitespace in old_string and omit Read's line-number annotations.

An ordinary edit requires exactly one occurrence of a nonempty old_string. Add surrounding source text to disambiguate repeated passages. Set replace_all only when every occurrence should change. new_string may be empty to delete the matched text, but it cannot equal old_string. For a new file or a deliberate full replacement, use Write.`;

export const inputSchema = {
  type: 'object',
  properties: {
    file_path: {
      type: 'string',
      description: 'Absolute filesystem path of the existing text file targeted by this replacement.',
    },
    old_string: {
      type: 'string',
      description:
        'Nonempty source passage to match literally, including whitespace; it must occur once unless replace_all is enabled.',
    },
    new_string: {
      type: 'string',
      description: 'Replacement passage; use an empty string for deletion. A value identical to old_string is rejected.',
    },
    replace_all: {
      type: 'boolean',
      description: 'Enable to change every non-overlapping match. If omitted or false, more than one match is rejected.',
    },
  },
  required: ['file_path', 'old_string', 'new_string'],
} as const;
