#!/usr/bin/env node
/*
 * docx-replace.cjs — find-and-replace text in a .docx, safe against run fragmentation.
 *
 * Word splits visible text across many <w:r> runs (spell-check, revision saves), so a
 * phrase you can read in the document often does not exist as one string in the XML.
 * This tool matches text across run boundaries within each paragraph and rewrites the
 * affected <w:t> elements, preserving the first run's formatting for replaced text.
 *
 * Usage:
 *   halo-node docx-replace.cjs <in.docx> "<old text>" "<new text>" -o <out.docx>
 *   Options:
 *     --all              replace every occurrence (default: first only)
 *     --part <name>      target part (default word/document.xml; use for headers/footers,
 *                        e.g. word/header1.xml)
 *     --dry-run          report matches without writing
 *
 * Matches never span paragraph boundaries. Prints the replacement count; exits 1 if the
 * text was not found (check headers/footers with --part, or inspect fragmentation with
 * ooxml.cjs cat).
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

// Replace `oldText` within one paragraph's XML. Returns { xml, count }.
function replaceInParagraph(pXml, oldText, newText, limit) {
  // collect <w:t> segments: [{open, text, closeStart}] with raw offsets
  const segRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:t(?:\s[^>]*)?\/>/g;
  const segs = [];
  let m;
  while ((m = segRe.exec(pXml)) !== null) {
    segs.push({ start: m.index, end: m.index + m[0].length, raw: m[0], text: m[1] === undefined ? '' : decode(m[1]) });
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

  // compute new text content per segment
  const newTexts = segs.map((s) => s.text);
  // process hits right-to-left so earlier offsets stay valid
  const starts = segs.map((s, i) => segs.slice(0, i).reduce((a, x) => a + x.text.length, 0));
  for (const hit of hits.reverse()) {
    const hitEnd = hit + oldText.length;
    let firstSeg = -1;
    for (let i = 0; i < segs.length; i++) {
      const s0 = starts[i];
      const s1 = s0 + segs[i].text.length;
      if (s1 <= hit || s0 >= hitEnd) continue;
      const local0 = Math.max(hit - s0, 0);
      const local1 = Math.min(hitEnd - s0, segs[i].text.length);
      if (firstSeg === -1) {
        firstSeg = i;
        newTexts[i] = newTexts[i].slice(0, local0) + newText + newTexts[i].slice(local1);
      } else {
        newTexts[i] = newTexts[i].slice(0, local0) + newTexts[i].slice(local1);
      }
    }
  }

  // rebuild paragraph XML right-to-left
  let out = pXml;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (newTexts[i] === segs[i].text) continue;
    const t = encode(newTexts[i]);
    const preserve = /^\s|\s$/.test(newTexts[i]) ? ' xml:space="preserve"' : '';
    out = out.slice(0, segs[i].start) + `<w:t${preserve}>${t}</w:t>` + out.slice(segs[i].end);
  }
  return { xml: out, count: hits.length };
}

function replaceInPart(xml, oldText, newText, all) {
  let remaining = all ? Infinity : 1;
  let total = 0;
  // paragraphs do not nest in WordprocessingML, so this scan is safe
  const out = xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (p) => {
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
  const opts = { part: 'word/document.xml', all: false, dryRun: false };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') opts.all = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--part') opts.part = argv[++i];
    else if (a === '-o' || a === '--out') opts.out = argv[++i];
    else pos.push(a);
  }
  const [file, oldText, newText] = pos;
  if (!file || oldText === undefined || newText === undefined) { usage(); process.exit(1); }
  if (!opts.out && !opts.dryRun) {
    console.error('Refusing to overwrite input: pass -o <out.docx> (or --dry-run).');
    process.exit(1);
  }

  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const part = zip.file(opts.part);
  if (!part) {
    console.error(`Part ${opts.part} not found in ${file}`);
    process.exit(1);
  }
  const xml = await part.async('string');
  const { xml: newXml, count } = replaceInPart(xml, oldText, newText, opts.all);

  if (!count) {
    console.error(`0 replacements — text not found in ${opts.part}. It may be in a header/footer (--part word/header1.xml), split across paragraphs, or spelled differently in the XML.`);
    process.exit(1);
  }
  if (opts.dryRun) {
    console.log(`${count} match(es) in ${opts.part} (dry run — nothing written)`);
    return;
  }
  zip.file(opts.part, newXml);
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(opts.out, buf);
  console.log(`${count} replacement(s) in ${opts.part} -> ${opts.out}`);
}

main().catch((err) => { console.error(`Error: ${err.message}`); process.exit(1); });
