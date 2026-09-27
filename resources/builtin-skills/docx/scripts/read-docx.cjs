#!/usr/bin/env node
/*
 * read-docx.cjs — extract readable content from a .docx as Markdown (default) or HTML.
 *
 * Usage:
 *   halo-node read-docx.cjs <file.docx>            # Markdown to stdout
 *   halo-node read-docx.cjs <file.docx> --html     # HTML (keeps more structure: tables)
 *
 * Notes:
 *   - Markdown mode flattens tables poorly; use --html when the document has tables.
 *   - Conversion warnings (unsupported styles etc.) are printed to stderr.
 *   - Only .docx is supported — legacy .doc will fail.
 */

const fs = require('fs');

function usage() {
  const lines = fs.readFileSync(__filename, 'utf8').split('\n');
  console.log(lines.slice(1, lines.indexOf(' */')).join('\n').replace(/^ \* ?/gm, ''));
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { usage(); process.exit(argv.length ? 0 : 1); }
  const html = argv.includes('--html');
  const file = argv.filter((a) => !a.startsWith('--'))[0];
  const mammoth = require('mammoth');
  const result = html
    ? await mammoth.convertToHtml({ path: file })
    : await mammoth.convertToMarkdown({ path: file });
  for (const msg of result.messages) console.error(`[${msg.type}] ${msg.message}`);
  console.log(result.value);
}

main().catch((err) => { console.error(`Error: ${err.message}`); process.exit(1); });
