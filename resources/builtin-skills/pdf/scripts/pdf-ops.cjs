#!/usr/bin/env node
/*
 * pdf-ops.cjs — merge, split, rotate, and watermark PDFs.
 *
 * Usage:
 *   halo-node pdf-ops.cjs merge <a.pdf> <b.pdf> [...] -o <out.pdf>
 *   halo-node pdf-ops.cjs split <in.pdf> --pages 1-3,7 -o <out.pdf>     # keep listed pages
 *   halo-node pdf-ops.cjs burst <in.pdf> -o <prefix>                    # one file per page: prefix-001.pdf ...
 *   halo-node pdf-ops.cjs rotate <in.pdf> --degrees 90 [--pages 2,4] -o <out.pdf>
 *   halo-node pdf-ops.cjs watermark <in.pdf> --text "DRAFT" [--size 60] [--opacity 0.15] -o <out.pdf>
 *
 * Pages are 1-based; ranges like 2-5 and lists like 1,3,8 both work. Degrees must be a
 * multiple of 90 (added to each page's current rotation). Watermark text is limited to
 * Latin-1 characters (standard-font encoding) — for CJK watermarks see references/creating.md.
 */

const fs = require('fs');

function usage() {
  const lines = fs.readFileSync(__filename, 'utf8').split('\n');
  console.log(lines.slice(1, lines.indexOf(' */')).join('\n').replace(/^ \* ?/gm, ''));
}

function parseArgs(argv) {
  const opts = { pos: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') opts.out = argv[++i];
    else if (a === '--pages') opts.pages = argv[++i];
    else if (a === '--degrees') opts.degrees = parseInt(argv[++i], 10);
    else if (a === '--text') opts.text = argv[++i];
    else if (a === '--size') opts.size = parseFloat(argv[++i]);
    else if (a === '--opacity') opts.opacity = parseFloat(argv[++i]);
    else opts.pos.push(a);
  }
  return opts;
}

function parseRange(spec, max) {
  const out = [];
  for (const part of spec.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`bad --pages spec: ${part}`);
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    for (let i = a; i <= Math.min(b, max); i++) if (!out.includes(i)) out.push(i);
  }
  return out;
}

async function load(file) {
  const { PDFDocument } = require('pdf-lib');
  return PDFDocument.load(fs.readFileSync(file));
}

async function cmdMerge(opts) {
  const { PDFDocument } = require('pdf-lib');
  if (opts.pos.length < 2) throw new Error('merge needs at least two input files');
  const out = await PDFDocument.create();
  for (const f of opts.pos) {
    const src = await load(f);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  fs.writeFileSync(opts.out, await out.save());
  console.log(`merged ${opts.pos.length} files -> ${opts.out} (${out.getPageCount()} pages)`);
}

async function cmdSplit(opts) {
  const { PDFDocument } = require('pdf-lib');
  const src = await load(opts.pos[0]);
  const keep = parseRange(opts.pages, src.getPageCount()).map((n) => n - 1);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, keep);
  pages.forEach((p) => out.addPage(p));
  fs.writeFileSync(opts.out, await out.save());
  console.log(`kept pages [${opts.pages}] of ${opts.pos[0]} -> ${opts.out}`);
}

async function cmdBurst(opts) {
  const { PDFDocument } = require('pdf-lib');
  const src = await load(opts.pos[0]);
  const n = src.getPageCount();
  const pad = String(n).length >= 3 ? String(n).length : 3;
  for (let i = 0; i < n; i++) {
    const out = await PDFDocument.create();
    const [p] = await out.copyPages(src, [i]);
    out.addPage(p);
    const name = `${opts.out}-${String(i + 1).padStart(pad, '0')}.pdf`;
    fs.writeFileSync(name, await out.save());
  }
  console.log(`burst ${opts.pos[0]} into ${n} files: ${opts.out}-${'1'.padStart(pad, '0')}.pdf ... ${opts.out}-${String(n).padStart(pad, '0')}.pdf`);
}

async function cmdRotate(opts) {
  const { degrees } = require('pdf-lib');
  if (!opts.degrees || opts.degrees % 90 !== 0) throw new Error('--degrees must be a non-zero multiple of 90');
  const doc = await load(opts.pos[0]);
  const targets = opts.pages ? parseRange(opts.pages, doc.getPageCount()) : doc.getPages().map((_, i) => i + 1);
  for (const n of targets) {
    const page = doc.getPage(n - 1);
    page.setRotation(degrees(((page.getRotation().angle + opts.degrees) % 360 + 360) % 360));
  }
  fs.writeFileSync(opts.out, await doc.save());
  console.log(`rotated page(s) ${opts.pages || 'all'} by ${opts.degrees}° -> ${opts.out}`);
}

async function cmdWatermark(opts) {
  const { StandardFonts, rgb, degrees } = require('pdf-lib');
  if (!opts.text) throw new Error('watermark needs --text');
  const doc = await load(opts.pos[0]);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const size = opts.size || 60;
  const opacity = opts.opacity === undefined ? 0.15 : opts.opacity;
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const textWidth = font.widthOfTextAtSize(opts.text, size);
    page.drawText(opts.text, {
      x: width / 2 - textWidth / 2 * Math.cos(Math.PI / 4),
      y: height / 2 - textWidth / 2 * Math.sin(Math.PI / 4),
      size, font, color: rgb(0.6, 0.6, 0.6), opacity, rotate: degrees(45),
    });
  }
  fs.writeFileSync(opts.out, await doc.save());
  console.log(`watermarked ${doc.getPageCount()} page(s) -> ${opts.out}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '--help' || cmd === '-h') { usage(); process.exit(cmd ? 0 : 1); }
  const opts = parseArgs(rest);
  if (!opts.out) { console.error('missing -o <output>'); process.exit(1); }
  if (cmd === 'merge') return cmdMerge(opts);
  if (cmd === 'split') return cmdSplit(opts);
  if (cmd === 'burst') return cmdBurst(opts);
  if (cmd === 'rotate') return cmdRotate(opts);
  if (cmd === 'watermark') return cmdWatermark(opts);
  usage();
  process.exit(1);
}

main().catch((err) => {
  const msg = String(err && err.message || err);
  if (/password|encrypted/i.test(msg)) console.error('Error: input PDF is encrypted — ask the user for the password or a decrypted copy.');
  else console.error(`Error: ${msg}`);
  process.exit(1);
});
