/**
 * @module tools/grep/schema
 * Grep tool description and input schema.
 * @license MIT
 */

export const name = 'Grep';

export const description =
  `Search local file contents with ripgrep regular expressions, subject to the session's read restrictions. Use this tool for ordinary content searches; a denied path remains denied when using another tool.

Start with a specific pattern and the smallest useful path. glob selects paths and type narrows recognized file extensions. Escape regex punctuation when searching for literal source text. The default search is case-sensitive and line-oriented; -i ignores case and multiline permits matches across line breaks, including newlines matched by a dot.

Choose files_with_matches to locate relevant files, content to inspect source lines, or count to see per-file totals. Context lines and line numbers are useful with content. Results are bounded: head_limit defaults to 250 entries, offset skips entries, and a separate character cap still applies. A truncation notice means some matches may be absent; narrow the query before drawing conclusions.`;

export const inputSchema = {
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description: 'Ripgrep-compatible expression to match against source text.',
    },
    path: {
      type: 'string',
      description: 'Search root: a file or directory. Omit to use the session working directory.',
    },
    type: {
      type: 'string',
      description: 'Named extension group, such as js, ts, py, go, or rust, used to restrict candidate files.',
    },
    glob: {
      type: 'string',
      description: 'Restrict candidate paths with a glob, such as "*.js" or "*.{ts,tsx}"; passed to ripgrep --glob.',
    },
    output_mode: {
      type: 'string',
      enum: ['content', 'files_with_matches', 'count'],
      description: 'Choose source lines with content, matching paths with files_with_matches, or per-file totals with count. The default is files_with_matches; pagination applies to each mode.',
    },
    '-B': {
      type: 'number',
      description:
        'Leading context lines for each content match. Has no effect on path lists or counts.',
    },
    '-A': {
      type: 'number',
      description:
        'Trailing context lines for each content match. Has no effect on path lists or counts.',
    },
    '-C': {
      type: 'number',
      description: 'Alias for context.',
    },
    context: {
      type: 'number',
      description:
        'Include this many surrounding lines on each side of a match. Applies to content output.',
    },
    '-n': {
      type: 'boolean',
      description:
        'Include source line numbers in content results. Enabled by default; other output modes ignore this option.',
    },
    '-i': {
      type: 'boolean',
      description: 'Match letters without distinguishing uppercase from lowercase.',
    },
    head_limit: {
      type: 'number',
      description:
        'Maximum entries after offset: source lines, file paths, or count rows according to output_mode. Defaults to 250. Zero removes this entry limit, but the output-size cap remains.',
    },
    offset: {
      type: 'number',
      description:
        'Number of result entries to skip before selecting the next window. Defaults to 0.',
    },
    multiline: {
      type: 'boolean',
      description:
        'Allow a match to cross line boundaries and let a dot match newline characters. Disabled by default; enables ripgrep -U and --multiline-dotall.',
    },
  },
  required: ['pattern'],
} as const;
