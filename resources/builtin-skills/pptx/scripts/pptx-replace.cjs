#!/usr/bin/env node
/*
 * pptx-replace.cjs — find-and-replace text in a .pptx, safe against run fragmentation.
 *
 * PowerPoint splits visible text across multiple <a:r> runs, so a phrase you can read
 * on a slide may not exist as one string in the XML. This tool matches across run
 * boundaries within each paragraph and rewrites the affected <a:t> elements, keeping
 * the first run's formatting for the replaced text.
 *
 * Usage:
 *   halo-node pptx-replace.cjs <in.pptx> "<old text>" "<new text>" -o <out.pptx>
 *   Options:
 *     --all           replace every occurrence (default: first only)
 *     --slide N       restrict to slide N's part (deck order not guaranteed to equal
 *                     file numbering — check with pptx-outline.cjs, which prints parts)
 *     --dry-run       report matches per slide without writing
 *
 * Prints replacements per part; exits 1 if nothing matched.
 */

const fs = require('fs');
const JSZip = require('jszip');

function usage() {
  const lines = fs.readFileSync(__filename, 'utf8').split('\n');
  console.log(lines.slice(1, lines.indexOf(' */')).join('\n').replace(/^ \* ?/gm, ''));
}

const decode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const encode = (s) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function replaceInParagraph(pXml, oldText, newText, limit) {
  const segRe = /<a:t>([\s\S]*?)<\/a:t>|<a:t\s[^>]*>([\s\S]*?)<\/a:t>|<a:t\/>/g;
  const segs = [];
  let m;
  while ((m = segRe.exec(pXml)) !== null) {
    const text = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : '');
    segs.push({ start: m.index, end: m.index + m[0].length, text: decode(text) });
  }
  if (!segs.length) return { xml: pXml, count: 0 };

  const concat = segs.map((s) => s.text).join('');
  const hits = [];
  let idx = 0;
  while (hits.length < limit && (idx = concat.indexOf(oldText, idx)) !== -1) {
    hits.push(idx);
    idx += oldText.length;
  }
  if (!hits.length) return { xml: pXml, count: 0 };

  const starts = segs.map((s, i) => segs.slice(0, i).reduce((a, x) => a + x.text.length, 0));
  const newTexts = segs.map((s) => s.text);
  for (const hit of hits.reverse()) {
    const hitEnd = hit + oldText.length;
    let first = true;
    for (let i = 0; i < segs.length; i++) {
      const s0 = starts[i];
      const s1 = s0 + segs[i].text.length;
      if (s1 <= hit || s0 >= hitEnd) continue;
      const l0 = Math.max(hit - s0, 0);
      const l1 = Math.min(hitEnd - s0, segs[i].text.length);
      if (first) { newTexts[i] = newTexts[i].slice(0, l0) + newText + newTexts[i].slice(l1); first = false; }
      else newTexts[i] = newTexts[i].slice(0, l0) + newTexts[i].slice(l1);
    }
  }

  let out = pXml;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (newTexts[i] === segs[i].text) continue;
    out = out.slice(0, segs[i].start) + `<a:t>${encode(newTexts[i])}</a:t>` + out.slice(segs[i].end);
  }
  return { xml: out, count: hits.length };
}

function replaceInPart(xml, oldText, newText, all) {
  let remaining = all ? Infinity : 1;
  let total = 0;
  const out = xml.replace(/<a:p>[\s\S]*?<\/a:p>|<a:p\s[^>]*>[\s\S]*?<\/a:p>/g, (p) => {
    if (remaining <= 0) return p;
    const r = replaceInParagraph(p, oldText, newText, remaining);
    remaining -= r.count;
    total += r.count;
    return r.xml;
  });
  return { xml: out, count: total };
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { usage(); process.exit(argv.length ? 0 : 1); }
  const opts = { all: false, dryRun: false };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') opts.all = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--slide') opts.slide = parseInt(argv[++i], 10);
    else if (a === '-o' || a === '--out') opts.out = argv[++i];
    else pos.push(a);
  }
  const [file, oldText, newText] = pos;
  if (!file || oldText === undefined || newText === undefined) { usage(); process.exit(1); }
  if (!opts.out && !opts.dryRun) {
    console.error('Refusing to overwrite input: pass -o <out.pptx> (or --dry-run).');
    process.exit(1);
  }

  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const parts = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .filter((n) => !opts.slide || n === `ppt/slides/slide${opts.slide}.xml`)
    .sort((a, b) => parseInt(a.match(/\d+/g).pop(), 10) - parseInt(b.match(/\d+/g).pop(), 10));
  if (!parts.length) {
    console.error(opts.slide ? `ppt/slides/slide${opts.slide}.xml not found` : 'no slides found');
    process.exit(1);
  }

  let total = 0;
  let remainingGlobal = opts.all ? Infinity : 1;
  for (const p of parts) {
    if (remainingGlobal <= 0) break;
    const xml = await zip.file(p).async('string');
    const { xml: newXml, count } = replaceInPart(xml, oldText, newText, opts.all);
    const used = Math.min(count, remainingGlobal);
    if (count > 0) {
      console.log(`${p}: ${count} replacement(s)`);
      if (!opts.dryRun) zip.file(p, newXml);
      total += count;
      remainingGlobal -= used;
    }
  }

  if (!total) {
    console.error('0 replacements — text not found on any slide. It may be split across paragraphs, in a layout/master, or spelled differently in the XML (inspect with pptx-outline.cjs / ooxml.cjs cat).');
    process.exit(1);
  }
  if (opts.dryRun) { console.log(`dry run — nothing written (${total} total)`); return; }
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(opts.out, buf);
  console.log(`wrote ${opts.out} (${total} total)`);
}

main().catch((err) => { console.error(`Error: ${err.message}`); process.exit(1); });
