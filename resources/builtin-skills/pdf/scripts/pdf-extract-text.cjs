#!/usr/bin/env node
/*
 * pdf-extract-text.cjs — extract text content from a PDF.
 *
 * Usage:
 *   halo-node pdf-extract-text.cjs <file.pdf>                # all pages, page-numbered
 *   halo-node pdf-extract-text.cjs <file.pdf> --pages 2-5    # page range (1-based)
 *   halo-node pdf-extract-text.cjs <file.pdf> --merged       # single block, no page markers
 *   halo-node pdf-extract-text.cjs <file.pdf> --json         # machine-readable
 *
 * A page with no extractable text is reported as [no text layer] — that usually means a
 * scanned/image page, which needs OCR instead (see the skill's Boundaries section).
 * Encrypted PDFs fail here; the user must supply the password or a decrypted copy.
 */

const fs = require('fs');

function usage() {
  const lines = fs.readFileSync(__filename, 'utf8').split('\n');
  console.log(lines.slice(1, lines.indexOf(' */')).join('\n').replace(/^ \* ?/gm, ''));
}

function parseRange(spec, max) {
  const out = new Set();
  for (const part of spec.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`bad --pages spec: ${part}`);
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    for (let i = a; i <= Math.min(b, max); i++) out.add(i);
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { usage(); process.exit(argv.length ? 0 : 1); }
  const merged = argv.includes('--merged');
  const asJson = argv.includes('--json');
  let pages = null;
  const pi = argv.indexOf('--pages');
  const file = argv.filter((a, i) => !a.startsWith('--') && (pi === -1 || i !== pi + 1))[0];

  const { extractText, getDocumentProxy } = require('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(file)));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  if (pi !== -1) pages = parseRange(argv[pi + 1], totalPages);

  const selected = text
    .map((t, i) => ({ page: i + 1, text: (t || '').trim() }))
    .filter((p) => !pages || pages.has(p.page));

  if (asJson) { console.log(JSON.stringify({ totalPages, pages: selected }, null, 2)); return; }
  if (merged) { console.log(selected.map((p) => p.text).filter(Boolean).join('\n\n')); return; }
  console.log(`${file} — ${totalPages} page(s)\n`);
  const emptyPages = [];
  for (const p of selected) {
    console.log(`--- Page ${p.page} ---`);
    if (p.text) console.log(p.text);
    else { console.log('[no text layer]'); emptyPages.push(p.page); }
    console.log('');
  }
  if (emptyPages.length) {
    console.error(`Note: page(s) ${emptyPages.join(', ')} have no text layer — likely scanned images. Use OCR for those pages.`);
  }
}

main().catch((err) => {
  const msg = String(err && err.message || err);
  if (/password|encrypted/i.test(msg)) console.error('Error: this PDF is encrypted — ask the user for the password or a decrypted copy.');
  else console.error(`Error: ${msg}`);
  process.exit(1);
});
