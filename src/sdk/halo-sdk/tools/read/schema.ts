/**
 * @module tools/read/schema
 * File Read tool description and input schema.
 * @license MIT
 */

export const name = 'Read';

export const description =
  `Inspect a local file within the session's permitted paths. Supply file_path; use Glob when you first need to locate a file.

For text, the initial window is at most 2,000 lines. Set offset to a one-based starting line and limit to the desired window; omitted offset or 0 starts at the beginning. Results prefix each source line with its number and a tab. These prefixes are display annotations, not file contents. Follow any continuation or truncation notice before treating the view as complete.

Text input is capped at 8 MiB. Larger files need a bounded streaming operation. Directory paths are rejected; missing files and denied paths produce errors. An empty file produces an explicit notice.

Supported images can be attached for visual inspection, including screenshots. Notebook input is rendered as cell source and available text outputs; binary cell outputs are not rendered. PDF handling currently reports the file and validates an optional page range of at most 20 pages; it does not extract PDF text. Use another available PDF-capable tool when the contents are required.`;

export const inputSchema = {
  type: 'object',
  properties: {
    file_path: {
      type: 'string',
      description: 'Identify the local file by its absolute filesystem path.',
    },
    offset: {
      type: 'integer',
      minimum: 0,
      description:
        'One-based starting line; omit or use 0 to start at the beginning.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      description:
        'Maximum lines in this text window; defaults to 2000.',
    },
    pages: {
      type: 'string',
      description:
        'PDF page selection: one page or an inclusive range, such as "2" or "4-8", spanning at most 20 pages. The current reader validates the selection without extracting text.',
    },
  },
  required: ['file_path'],
} as const;
